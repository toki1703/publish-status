'use strict';

var obsidian = require('obsidian');

const VIEW_TYPE_PUBLISH_EXPLORER = 'publish-explorer';
const VIEW_TYPE_PUBLISH_DIFF = 'publish-diff';

// ── ステータス解決 ────────────────────────────────────────────

function resolveStatus(item) {
	if (item.type === 'deleted') {
		return { letter: 'D', colorCls: 'publish-status-deleted' };
	}
	if (item.checked) {
		if (item.ctime === 0) {
			return { letter: 'A', colorCls: 'publish-status-added' };
		}
		return { letter: 'M', colorCls: 'publish-status-modified' };
	}
	return null;
}

function resolvePublishStatus(item) {
	if (item.type === 'deleted') {
		return { letter: 'D', colorCls: 'publish-status-deleted' };
	}
	if (item.ctime > 0) {
		if (item.checked) {
			return { letter: 'M', colorCls: 'publish-status-modified' };
		}
		return { letter: null, colorCls: 'publish-status-clean' };
	}
	return null;
}

// ── ツリー構築 ────────────────────────────────────────────────

function buildTree(entries) {
	const root = { children: {}, files: [] };
	for (const entry of entries) {
		const parts = entry.path.split('/');
		const fileName = parts[parts.length - 1];
		const dirs = parts.slice(0, -1);
		let node = root;
		for (const dir of dirs) {
			if (!node.children[dir]) {
				node.children[dir] = { children: {}, files: [] };
			}
			node = node.children[dir];
		}
		node.files.push({ name: fileName, path: entry.path, status: entry.status });
	}
	return root;
}

function buildPublishExplorerEntries(publishMap, statusMap) {
	const entryMap = new Map(publishMap);
	for (const [path, status] of statusMap) {
		if (status.letter === 'A' && !entryMap.has(path)) {
			entryMap.set(path, status);
		}
	}
	return Array.from(entryMap, ([path, status]) => ({ path, status }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

// ── diff アルゴリズム (LCS) ───────────────────────────────────

function computeDiff(oldLines, newLines) {
	const m = oldLines.length;
	const n = newLines.length;

	if (m * n > 600000) {
		return [
			...oldLines.map(text => ({ type: 'delete', text })),
			...newLines.map(text => ({ type: 'insert', text })),
		];
	}

	const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = oldLines[i - 1] === newLines[j - 1]
				? dp[i - 1][j - 1] + 1
				: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	const result = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			result.unshift({ type: 'equal', text: oldLines[i - 1] });
			i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.unshift({ type: 'insert', text: newLines[j - 1] });
			j--;
		} else {
			result.unshift({ type: 'delete', text: oldLines[i - 1] });
			i--;
		}
	}
	return result;
}

function groupHunks(diff) {
	const hunks = [];
	for (const item of diff) {
		const last = hunks[hunks.length - 1];
		if (last && last.type === item.type) {
			last.lines.push(item.text);
		} else {
			hunks.push({ type: item.type, lines: [item.text] });
		}
	}
	return hunks;
}

// ── Publish 版コンテンツ取得 ──────────────────────────────────

async function fetchPublishContent(inst, path, options = {}) {
	const host = inst?.host;
	const siteId = inst?.siteId;
	if (!host || !siteId) return null;

	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	const cacheBust = options.cacheBust ? `?publish-status-ts=${Date.now()}` : '';
	try {
		const res = await obsidian.requestUrl({
			url: `https://${host}/access/${siteId}/${encodedPath}${cacheBust}`,
		});

		if (res.status === 200) {
			// Obsidian Publish はファイル非存在時にも 200 OK を返すため、内容で除外する
			
			// 判定1: ETag が '404' かどうか（大文字小文字のブレを考慮）
			const etag = res.headers?.etag ?? res.headers?.ETag;
			if (etag === '404') {
				return null;
			}

			// // 判定2: 本文が "## Not Found" のテンプレートかどうか（ETag仕様変更への保険）
			// const text = (res.text ?? '').trim();
			// if (text.startsWith('## Not Found') && text.includes('does not exist.')) {
			// 	return null;
			// }

			// どちらにも引っかからなければ、正規のコンテンツとして返す
			return res.text;
		}
	} catch (_) { 
		/* 取得失敗 (ネットワークエラーやガチの404など) */ 
	}

	return null;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getPublishInstance(app) {
	return app.internalPlugins?.plugins?.['publish']?.instance;
}

function getPublishToken() {
	try {
		return JSON.parse(localStorage['obsidian-account'] ?? '{}')?.token ?? null;
	} catch (_) {
		return null;
	}
}

function readResponseJson(res) {
	if (res.json) return res.json;
	try {
		return JSON.parse(res.text ?? '{}');
	} catch (_) {
		return {};
	}
}

async function sha256Hex(content) {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadPublishMarkdown(inst, path, content, hash) {
	const host = inst?.host;
	const siteId = inst?.siteId;
	const token = getPublishToken();
	if (!host || !siteId) throw new Error('Publish site information is missing');
	if (!token) throw new Error('Obsidian account token is missing');

	const res = await obsidian.requestUrl({
		url: `https://${host}/api/upload`,
		method: 'POST',
		headers: {
			'content-type': 'application/octet-stream',
			'obs-hash': hash ?? await sha256Hex(content),
			'obs-id': siteId,
			'obs-path': encodeURIComponent(path),
			'obs-token': token,
		},
		body: content,
	});

	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Upload failed with status ${res.status}`);
	}
	return res;
}

async function removePublishFile(inst, path) {
	const host = inst?.host;
	const siteId = inst?.siteId;
	const token = getPublishToken();
	if (!host || !siteId) throw new Error('Publish site information is missing');
	if (!token) throw new Error('Obsidian account token is missing');

	const res = await obsidian.requestUrl({
		url: `https://${host}/api/remove`,
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			path,
			id: siteId,
			token,
		}),
	});

	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Remove failed with status ${res.status}`);
	}
	return res;
}

async function fetchPublishDefaultBaseUrl(inst) {
	const siteId = inst?.siteId;
	const token = getPublishToken();
	if (!siteId) throw new Error('Publish site information is missing');
	if (!token) throw new Error('Obsidian account token is missing');

	const res = await obsidian.requestUrl({
		url: 'https://publish.obsidian.md/api/slugs',
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			ids: [siteId],
			token,
		}),
	});

	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Slug request failed with status ${res.status}`);
	}

	const slug = readResponseJson(res)?.[siteId];
	if (!slug) throw new Error('Publish slug is missing');
	return `https://publish.obsidian.md/${slug}`;
}

async function fetchPublishCustomBaseUrl(inst) {
	const host = inst?.host;
	const siteId = inst?.siteId;
	const token = getPublishToken();
	if (!host || !siteId) throw new Error('Publish site information is missing');
	if (!token) throw new Error('Obsidian account token is missing');

	const res = await obsidian.requestUrl({
		url: 'https://publish.obsidian.md/api/customurl',
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			id: siteId,
			host,
			token,
		}),
	});

	if (res.status < 200 || res.status >= 300) return null;
	const data = readResponseJson(res);
	if (!data?.redirect || !data?.url) return null;
	return data.url.match(/^https?:\/\//) ? data.url : `https://${data.url}`;
}

async function fetchPublishBaseUrl(inst) {
	let customUrl = null;
	try {
		customUrl = await fetchPublishCustomBaseUrl(inst);
	} catch (e) {
		console.warn('[PublishStatus] custom URL lookup failed', e);
	}
	return customUrl ?? await fetchPublishDefaultBaseUrl(inst);
}

function getPublishPathFromPermalink(app, path) {
	const file = app.vault.getFileByPath(path);
	const permalink = file
		? app.metadataCache.getFileCache(file)?.frontmatter?.permalink
		: null;
	const publishPath = typeof permalink === 'string' && permalink.trim()
		? permalink.trim()
		: path.replace(/\.md$/i, '');
	return publishPath.replace(/^\/+/, '');
}

function buildPublishUrl(baseUrl, publishPath) {
	const cleanBase = baseUrl.replace(/\/+$/, '');
	const cleanPath = publishPath.replace(/^\/+/, '');
	if (!cleanPath) return cleanBase;
	const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
	return `${cleanBase}/${encodedPath}`;
}

function addMenuSectionHeader(menu, title) {
	menu.addItem((item) => {
		item
			.setTitle(title)
			.setDisabled(true);
	});
}

function getPublishAction(statusLetter) {
	if (statusLetter === 'D') {
		return { title: 'リモートを削除する', icon: 'trash-2', kind: 'remove' };
	}
	if (statusLetter === 'A') {
		return { title: 'リモートに追加する', icon: 'upload-cloud', kind: 'publish' };
	}
	if (statusLetter === 'M') {
		return { title: 'リモートに反映する', icon: 'refresh-cw', kind: 'publish' };
	}
	return { title: 'ページを削除する', icon: 'trash-2', kind: 'remove' };
}

// ── Publish Diff View ─────────────────────────────────────────

class PublishDiffView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.filePath = null;
        this.statusLetter = null;
        this.publishContent = null;
        this.publishHash = null;
        this.localHash = null;
        this.bodyEl = null;
        this.headerTitleEl = null;
        this._rerenderTimer = null;
        this._renderToken = 0;
        this.viewTitle = 'Publish Diff';
    }

    getViewType() { return VIEW_TYPE_PUBLISH_DIFF; }
    getDisplayText() { return this.viewTitle; }
    getIcon() { return 'git-compare'; }

    _buildTitle() {
        const name = this.filePath?.split('/').pop() ?? 'Publish Diff';
        const p = this.publishHash ?? '-------';
        const l = this.localHash ?? '-------';
        return `${name} (${p}) ↔ ${name} (${l})`;
    }

    async setState(state = {}, result) {
        this.filePath = state.path ?? null;
        this.statusLetter = state.statusLetter ?? null;
        this.viewTitle = state.viewTitle ?? this._buildTitle();
        await super.setState(state, result);
        this._forceTabTitleUpdate();
        if (this.filePath) await this.loadAndRender();
    }

    async setFile(path, statusLetter) {
        this.filePath = path;
        this.statusLetter = statusLetter ?? null;
        this.publishHash = null;
        this.localHash = null;
        this.publishContent = null;
        this.viewTitle = this._buildTitle();
        this._updateHeaderTitle();
        this._forceTabTitleUpdate();
        await this.loadAndRender();
    }

    getState() {
        return {
            path: this.filePath,
            statusLetter: this.statusLetter,
            viewTitle: this.viewTitle,
        };
    }

    async _syncTitleState() {
        this.viewTitle = this._buildTitle();
        this._updateHeaderTitle();
        this._forceTabTitleUpdate();
    }
	
	async onOpen() {
		const c = this.containerEl.children[1];
		c.empty();
		c.addClass('publish-diff-container');
		if (!this.filePath) {
			c.createDiv({ cls: 'publish-diff-empty', text: 'ファイルを選択してください' });
		}

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file.path !== this.filePath || this.publishContent === null) return;
			clearTimeout(this._rerenderTimer);
			this._rerenderTimer = setTimeout(() => this._rerenderDiff(), 300);
		}));
	}

	async onClose() {
		clearTimeout(this._rerenderTimer);
	}

	// ── [修正] cacheBust オプションを追加 ──────────────────────
    async loadAndRender(options = {}) {
        const renderToken = ++this._renderToken;
        const c = this.containerEl.children[1];
        c.empty();
        c.addClass('publish-diff-container');

        const { filePath, statusLetter } = this;

        this.publishHash = null;
        this.localHash = null;
        this.viewTitle = this._buildTitle();

        const header = c.createDiv({ cls: 'publish-diff-header' });
        const colorCls = { D: 'publish-status-deleted', M: 'publish-status-modified', A: 'publish-status-added' }[statusLetter] ?? 'publish-status-clean';
        header.createSpan({ cls: `publish-diff-badge ${colorCls}`, text: statusLetter ?? '?' });
        this.headerTitleEl = header.createSpan({ cls: 'publish-diff-title', text: this.viewTitle });
        if (statusLetter !== 'D') {
            const uploadBtn = header.createEl('button', { cls: 'publish-diff-upload-btn clickable-icon' });
            obsidian.setIcon(uploadBtn, 'upload-cloud');
            uploadBtn.setAttribute('aria-label', '公開する');
			uploadBtn.addEventListener('click', async () => {
				if (!this.filePath) return;
				uploadBtn.disabled = true;
				try {
					await this.plugin.publishFileByPath(this.filePath);
				} finally {
					uploadBtn.disabled = false;
				}
			});
        }

        this.bodyEl = c.createDiv({ cls: 'publish-diff-body' });
        const loadingEl = this.bodyEl.createDiv({ cls: 'publish-diff-loading', text: 'Publish 版を取得中…' });

        const inst = getPublishInstance(this.plugin.app);
		// [修正] cacheBust オプションをそのまま渡す
        this.publishContent = inst
			? await fetchPublishContent(inst, filePath, { cacheBust: !!options.cacheBust })
			: null;
        if (renderToken !== this._renderToken) return;

        let localContent = null;
        if (statusLetter !== 'D') {
            const vaultFile = this.app.vault.getFileByPath(filePath);
            if (vaultFile) localContent = await this.app.vault.read(vaultFile);
        }
        if (renderToken !== this._renderToken) return;

        this.publishHash = await this._contentHash(this.publishContent);
        this.localHash = await this._contentHash(localContent);
        if (renderToken !== this._renderToken) return;

        loadingEl.remove();
        this._renderDiff(localContent);
        await this._syncTitleState();
    }

	_updateHeaderTitle() {
		if (!this.headerTitleEl || !this.filePath) return;
		this.headerTitleEl.setText(this.viewTitle);
	}

	_forceTabTitleUpdate() {
		this.viewTitle = this._buildTitle();

		const titleEl = this.leaf.tabHeaderInnerTitleEl;
		if (titleEl) {
			titleEl.textContent = this.viewTitle;
		}

		const headerTitleEl = this.containerEl
			.closest('.workspace-leaf')
			?.querySelector('.view-header-title');
		if (headerTitleEl) {
			headerTitleEl.textContent = this.viewTitle;
		}

		this.app.workspace.trigger('layout-change');
	}

	// ── [修正] showLoadingSpinner で _renderToken をインクリメント ──
	showLoadingSpinner() {
		if (!this.bodyEl) return;
		// renderToken を進めることで、進行中の loadAndRender があれば無効化する
		this._renderToken++;
		this.bodyEl.empty();
		const wrap = this.bodyEl.createDiv({ cls: 'publish-diff-loading-spinner-wrap' });
		wrap.createSpan({ cls: 'publish-loading-spinner publish-loading-spinner--lg' });
		wrap.createDiv({ 
			cls: 'publish-diff-loading-text', 
			text: 'アップロード・反映待機中...',
			attr: { style: 'margin-top: 12px; color: var(--text-muted); font-size: 0.9em;' }
		});
	}

	_renderDiff(localContent) {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		const { statusLetter } = this;

		if (statusLetter === 'D') {
			if (this.publishContent !== null) {
				this.renderUnified(this.bodyEl, this.publishContent, null);
			} else {
				this.renderMessage(this.bodyEl, 'Publish 版のコンテンツを取得できませんでした');
			}
			return;
		}

		if (statusLetter === 'A' && localContent !== null && this.publishContent === null) {
			this.renderMessage(this.bodyEl, 'Publish に追加予定のローカル版を表示', 'warn');
			this.renderUnified(this.bodyEl, '', localContent);
		} else if (this.publishContent !== null && localContent !== null) {
			this.renderUnified(this.bodyEl, this.publishContent, localContent);
		} else if (localContent !== null) {
			this.renderMessage(this.bodyEl, 'Publish 版を取得できませんでした — ローカル版を表示', 'warn');
			this.renderUnified(this.bodyEl, localContent, localContent);
		} else {
			this.renderMessage(this.bodyEl, 'コンテンツを取得できませんでした');
		}
	}

	async _rerenderDiff() {
		if (!this.bodyEl || !this.filePath || this.statusLetter === 'D') return;
		const vaultFile = this.app.vault.getFileByPath(this.filePath);
		if (!vaultFile) return;
		const localContent = await this.app.vault.read(vaultFile);
		this.localHash = await this._contentHash(localContent);
		this._renderDiff(localContent);
		await this._syncTitleState();
	}

	async _contentHash(content) {
		if (!content) return null;
		return (await sha256Hex(content)).slice(0, 7);
	}

	renderUnified(container, publishContent, localContent) {
		const publishLines = publishContent ? publishContent.split('\n') : [];
		const localLines   = localContent   ? localContent.split('\n')   : [];

		if (localContent === null) {
			let pn = 1;
			for (const line of publishLines) {
				this.renderRow(container, 'delete', pn++, null, line);
			}
			return;
		}

		const diff  = computeDiff(publishLines, localLines);
		const hunks = groupHunks(diff);

		let pn = 1, ln = 1;
		for (const hunk of hunks) {
			for (const text of hunk.lines) {
				if (hunk.type === 'equal') {
					this.renderRow(container, 'equal', pn++, ln++, text);
				} else if (hunk.type === 'delete') {
					this.renderRow(container, 'delete', pn++, null, text);
				} else {
					this.renderRow(container, 'insert', null, ln++, text);
				}
			}
		}
	}

	renderRow(container, type, pn, ln, text) {
		const row = container.createDiv({ cls: `publish-diff-row publish-diff-row-${type}` });
		row.createSpan({ cls: 'publish-diff-num', text: pn != null ? String(pn) : '' });
		row.createSpan({ cls: 'publish-diff-num', text: ln != null ? String(ln) : '' });
		row.createSpan({
			cls: 'publish-diff-marker',
			text: type === 'delete' ? '−' : type === 'insert' ? '+' : ' ',
		});
		row.createSpan({ cls: 'publish-diff-text', text });
	}

	renderMessage(container, text, level = 'error') {
		container.createDiv({ cls: `publish-diff-message publish-diff-message-${level}`, text });
	}
}

// ── Publish Explorer View ─────────────────────────────────────

class PublishExplorerView extends obsidian.ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_PUBLISH_EXPLORER; }
	getDisplayText() { return 'Publish Explorer'; }
	getIcon() { return 'upload-cloud'; }

	async onOpen() { this.render(); }
	async onClose() {}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('publish-explorer-container');

		const header = container.createDiv({ cls: 'publish-explorer-header' });
		header.createSpan({ cls: 'publish-explorer-title', text: 'PUBLISH EXPLORER' });
		const syncBtn = header.createEl('button', { cls: 'publish-explorer-sync-btn clickable-icon' });
		obsidian.setIcon(syncBtn, 'arrow-up-down');
		syncBtn.setAttribute('aria-label', 'すべての変更を同期');
		syncBtn.addEventListener('click', async () => {
			syncBtn.disabled = true;
			try { await this.plugin.syncAll(); }
			finally { syncBtn.disabled = false; }
		});

		const refreshBtn = header.createEl('button', { cls: 'publish-explorer-refresh-btn clickable-icon' });
		obsidian.setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.setAttribute('aria-label', 'Refresh');
		refreshBtn.addEventListener('click', async () => { await this.plugin.refresh(); });

		const content = container.createDiv({ cls: 'publish-explorer-content' });

		const entries = buildPublishExplorerEntries(this.plugin.publishMap, this.plugin.statusMap);
		if (entries.length === 0) {
			content.createDiv({ cls: 'publish-explorer-empty', text: 'Publish 上にファイルがありません' });
			return;
		}

		this.renderTree(content, buildTree(entries), 0);
	}

	renderTree(container, node, depth) {
		const indent = depth * 16;

		for (const [folderName, child] of Object.entries(node.children).sort(([a], [b]) => a.localeCompare(b))) {
			const folderRow = container.createDiv({ cls: 'publish-explorer-folder-row' });
			folderRow.style.paddingLeft = `${indent + 8}px`;

			const chevron = folderRow.createSpan({ cls: 'publish-explorer-chevron' });
			obsidian.setIcon(chevron, 'chevron-down');

			const iconEl = folderRow.createSpan({ cls: 'publish-explorer-folder-icon' });
			obsidian.setIcon(iconEl, 'folder');

			folderRow.createSpan({ cls: 'publish-explorer-folder-name', text: folderName });

			const childContainer = container.createDiv({ cls: 'publish-explorer-folder-children' });
			this.renderTree(childContainer, child, depth + 1);

			folderRow.addEventListener('click', () => {
				const collapsed = childContainer.hasClass('is-collapsed');
				if (collapsed) {
					childContainer.removeClass('is-collapsed');
					obsidian.setIcon(chevron, 'chevron-down');
				} else {
					childContainer.addClass('is-collapsed');
					obsidian.setIcon(chevron, 'chevron-right');
				}
			});
		}

		for (const file of node.files) {
			const fileRow = container.createDiv({ cls: 'publish-explorer-file-row is-clickable' });
			fileRow.style.paddingLeft = `${indent + 24}px`;
			fileRow.title = file.path;

			fileRow.createSpan({
				cls: `publish-explorer-file-name ${file.status.colorCls}`,
				text: file.name,
			});

			if (this.plugin.uploadingPaths.has(file.path)) {
				fileRow.createSpan({ cls: 'publish-loading-spinner' });
			} else if (file.status.letter) {
				fileRow.createSpan({
					cls: `publish-status-letter ${file.status.colorCls}`,
					text: file.status.letter,
				});
			}

			fileRow.addEventListener('click', () => {
				this.plugin.openDiff(file.path, file.status);
			});

			fileRow.addEventListener('contextmenu', (event) => {
				const action = getPublishAction(file.status.letter);
				if (!action) return;

				event.preventDefault();
				const menu = new obsidian.Menu();

				addMenuSectionHeader(menu, '差分');
				menu.addItem((item) => {
					item
						.setTitle('差分を表示する')
						.setIcon('git-compare')
						.onClick(() => {
							this.plugin.openDiff(file.path, file.status);
						});
				});

				menu.addSeparator();
				addMenuSectionHeader(menu, 'ローカル');
				menu.addItem((item) => {
					item
						.setTitle('ローカルを削除する')
						.setIcon('trash-2')
						.onClick(async () => {
							await this.plugin.deleteLocalFile(file.path);
						});
				});

				menu.addSeparator();
				addMenuSectionHeader(menu, 'リモート');
				menu.addItem((item) => {
					item
						.setTitle(action.title)
						.setIcon(action.icon)
						.onClick(async () => {
							if (action.kind === 'remove') {
								await this.plugin.removeRemoteFile(file.path);
							} else {
								await this.plugin.publishFileByPath(file.path);
							}
						});
				});
				if (file.status.letter !== 'A') {
					menu.addItem((item) => {
						item
							.setTitle('リモートのリンクをコピーする')
							.setIcon('link')
							.onClick(async () => {
								await this.plugin.copyRemoteLink(file.path);
							});
					});
				}
				menu.showAtMouseEvent(event);
			});
		}
	}
}

// ── Plugin ────────────────────────────────────────────────────

class PublishStatusPlugin extends obsidian.Plugin {
	async onload() {
		this.statusMap = new Map();
		this.publishMap = new Map();
		this.uploadingPaths = new Set();

		this.registerView(VIEW_TYPE_PUBLISH_EXPLORER, leaf => new PublishExplorerView(leaf, this));
		this.registerView(VIEW_TYPE_PUBLISH_DIFF,     leaf => new PublishDiffView(leaf, this));

		this.addCommand({
			id: 'refresh-publish-status',
			name: 'Refresh Publish Status',
			callback: () => this.refresh(),
		});

		this.addCommand({
			id: 'open-publish-explorer',
			name: 'Open Publish Explorer',
			callback: () => this.openPublishExplorer(),
		});

		this.addCommand({
			id: 'publish-current-file',
			name: 'Publish Current File',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.publishFile(file);
				return true;
			},
		});

		this.addRibbonIcon('upload-cloud', 'Publish Explorer を開く', () => this.openPublishExplorer());

		this.app.workspace.onLayoutReady(async () => { await this.refresh(); });

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
		this.registerEvent(this.app.vault.on('modify', () => this.refresh()));
	}

	onunload() {
		this.clearDecorations();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PUBLISH_EXPLORER);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PUBLISH_DIFF);
	}

	async openPublishExplorer() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_EXPLORER);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE_PUBLISH_EXPLORER, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	async openDiff(path, status) {
		const diffLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_DIFF);
		let diffLeaf = diffLeaves[0] ?? null;

		if (diffLeaf) {
			await this.app.workspace.revealLeaf(diffLeaf);
		} else {
			diffLeaf = this.app.workspace.getLeaf('tab');
			await diffLeaf.setViewState({
				type: VIEW_TYPE_PUBLISH_DIFF,
				active: true,
			});
			diffLeaf.setPinned(true);
			this.fileLeaf = null;
		}

		if (diffLeaf.view?.setFile) {
			await diffLeaf.view.setFile(path, status.letter);
		}

		if (status.letter !== 'D') {
			const file = this.app.vault.getFileByPath(path);
			if (file) {
				if (this.fileLeaf?.parent) {
					await this.fileLeaf.openFile(file, { active: true });
				} else {
					this.app.workspace.revealLeaf(diffLeaf);
					this.fileLeaf = this.app.workspace.getLeaf('split', 'vertical');
					await this.fileLeaf.openFile(file, { active: true });
				}
			}
		}
	}

	async refresh() {
		const inst = getPublishInstance(this.app);
		if (!inst) {
			new obsidian.Notice('Publish plugin が無効です');
			return;
		}

		try {
			const changes = await inst.scanForChanges();
			this.statusMap.clear();
			this.publishMap.clear();
			for (const item of changes) {
				const status = resolveStatus(item);
				if (status) this.statusMap.set(item.path, status);

				const publishStatus = resolvePublishStatus(item);
				if (publishStatus) this.publishMap.set(item.path, publishStatus);
			}
			console.log('[PublishStatus] statusMap:', this.statusMap.size, 'publishMap:', this.publishMap.size);
			this.decorate();
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_EXPLORER)) {
				leaf.view.render();
			}
		} catch (e) {
			console.error('[PublishStatus] scanForChanges failed', e);
			new obsidian.Notice('Publish Status の取得に失敗しました');
		}
	}

	async publishFileByPath(path) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new obsidian.Notice(`ファイルが見つかりません: ${path}`);
			return false;
		}
		return this.publishFile(file);
	}

	async publishFile(file) {
		const inst = getPublishInstance(this.app);
		if (!inst) {
			new obsidian.Notice('Publish plugin が無効です');
			return false;
		}

		// エクスプローラー側スピナー開始
		this.uploadingPaths.add(file.path);
		this._reRenderExplorer();

		// [修正] showLoadingSpinner は _renderToken をインクリメントするので
		// 後続の loadAndRender(cacheBust) がきちんと上書きできる
		this._getDiffViewForPath(file.path)?.showLoadingSpinner();

		let uploadedHash = null;
		try {
			const content = await this.app.vault.read(file);
			const hash = await sha256Hex(content);
			await uploadPublishMarkdown(inst, file.path, content, hash);
			uploadedHash = hash;

			await this.waitForPublishedContent(file.path, hash);
			// waitForPublishedContent がキャッシュバスト付きで確認済みなので
			// ここでは sleep なしでよい（必要なら残しても可）

			new obsidian.Notice(`公開しました: ${file.path}`);
			await this.refresh();
			return { hash };
		} catch (e) {
			console.error('[PublishStatus] upload failed', e);
			new obsidian.Notice(`公開に失敗しました: ${e?.message ?? e}`);
			return false;
		} finally {
			// エクスプローラー側スピナー解除
			this.uploadingPaths.delete(file.path);
			this._reRenderExplorer();

			// [修正] 成功時はキャッシュバスト付きで再描画（古いコンテンツを掴まない）
			//        失敗時も同様に再描画してスピナーを解除する
			const diffView = this._getDiffViewForPath(file.path);
			if (diffView) {
				void diffView.loadAndRender({ cacheBust: uploadedHash !== null });
			}
		}
	}
	
	async syncAll() {
		const inst = getPublishInstance(this.app);
		if (!inst) {
			new obsidian.Notice('Publish plugin が無効です');
			return;
		}

		// 最新の状態を取得してから同期
		await this.refresh();

		const tasks = [];

		for (const [path, status] of this.statusMap) {
			if (status.letter === 'A' || status.letter === 'M') {
				// ローカル追加 / 変更 → リモートに反映
				tasks.push({ path, kind: 'publish' });
			} else if (status.letter === 'D') {
				// ローカル削除（= publishMap にある & ローカルにない）→ リモートも削除
				tasks.push({ path, kind: 'remove' });
			}
		}

		// publishMap にあって statusMap にない = リモートのみ存在（D 扱い）→ ローカル削除
		for (const [path] of this.publishMap) {
			if (!this.statusMap.has(path)) {
				const file = this.app.vault.getFileByPath(path);
				if (!file) {
					// ローカルに存在しない → リモートを削除
					tasks.push({ path, kind: 'remove' });
				}
			}
		}

		if (tasks.length === 0) {
			new obsidian.Notice('同期するファイルはありません');
			return;
		}

		new obsidian.Notice(`${tasks.length} 件のファイルを同期中…`);

		let succeeded = 0;
		let failed = 0;

		for (const task of tasks) {
			try {
				if (task.kind === 'publish') {
					const file = this.app.vault.getFileByPath(task.path);
					if (!file) { failed++; continue; }
					const content = await this.app.vault.read(file);
					const hash = await sha256Hex(content);
					this.uploadingPaths.add(task.path);
					this._reRenderExplorer();
					await uploadPublishMarkdown(inst, task.path, content, hash);
					this.uploadingPaths.delete(task.path);
					this._reRenderExplorer();
					succeeded++;
				} else if (task.kind === 'remove') {
					await removePublishFile(inst, task.path);
					succeeded++;
				}
			} catch (e) {
				this.uploadingPaths.delete(task.path);
				console.error(`[PublishStatus] syncAll failed: ${task.path}`, e);
				failed++;
			}
		}

		this.uploadingPaths.clear();
		await this.refresh();

		const msg = failed === 0
			? `同期完了: ${succeeded} 件`
			: `同期完了: ${succeeded} 件成功、${failed} 件失敗`;
		new obsidian.Notice(msg);
	}

	// [追加] 対象パスの DiffView を取得するヘルパー
	_getDiffViewForPath(path) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_DIFF)) {
			if (leaf.view.filePath === path) return leaf.view;
		}
		return null;
	}

	async waitForPublishedContent(path, expectedHash) {
		const inst = getPublishInstance(this.app);
		if (!inst || !expectedHash) return false;

		const timeoutMs = 15000;
		const intervalMs = 800;
		const startTime = Date.now();

		while (Date.now() - startTime <= timeoutMs) {
			await sleep(intervalMs);
			const publishContent = await fetchPublishContent(inst, path, { cacheBust: true });
			if (publishContent !== null && (await sha256Hex(publishContent)) === expectedHash) {
				return true;
			}
		}

		new obsidian.Notice('公開は完了しましたが、Publish 側への反映確認がタイムアウトしました');
		return false;
	}
	
	_reRenderExplorer() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_EXPLORER)) {
			leaf.view.render();
		}
	}

	async removeRemoteFile(path) {
		const inst = getPublishInstance(this.app);
		if (!inst) {
			new obsidian.Notice('Publish plugin が無効です');
			return false;
		}

		try {
			await removePublishFile(inst, path);
			new obsidian.Notice(`リモートを削除しました: ${path}`);
			await this.refresh();
			return true;
		} catch (e) {
			console.error('[PublishStatus] remove failed', e);
			new obsidian.Notice(`リモート削除に失敗しました: ${e?.message ?? e}`);
			return false;
		}
	}

	async copyRemoteLink(path) {
		const inst = getPublishInstance(this.app);
		if (!inst) {
			new obsidian.Notice('Publish plugin が無効です');
			return false;
		}

		try {
			const baseUrl = await fetchPublishBaseUrl(inst);
			const publishPath = getPublishPathFromPermalink(this.app, path);
			const url = buildPublishUrl(baseUrl, publishPath);
			await navigator.clipboard.writeText(url);
			new obsidian.Notice(`リモートのリンクをコピーしました: ${url}`);
			return true;
		} catch (e) {
			console.error('[PublishStatus] copy remote link failed', e);
			new obsidian.Notice(`リモートのリンクコピーに失敗しました: ${e?.message ?? e}`);
			return false;
		}
	}

	async deleteLocalFile(path) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			new obsidian.Notice(`ファイルが見つかりません: ${path}`);
			return false;
		}

		try {
			await this.app.vault.trash(file, true);
			new obsidian.Notice(`ローカルを削除しました: ${path}`);
			await this.refresh();
			return true;
		} catch (e) {
			console.error('[PublishStatus] delete local failed', e);
			new obsidian.Notice(`ローカル削除に失敗しました: ${e?.message ?? e}`);
			return false;
		}
	}

	clearDecorations() {
		document.querySelectorAll('.publish-status-fe-letter').forEach(el => el.remove());
		document.querySelectorAll('.tree-item-inner[class*="publish-status-"]').forEach(el => {
			el.classList.remove('publish-status-added', 'publish-status-modified', 'publish-status-deleted');
		});
	}

	decorate() {
		this.clearDecorations();
		const titleEls = document.querySelectorAll('.tree-item-self[data-path]');
		let decorated = 0;
		for (const titleEl of titleEls) {
			const path = titleEl.getAttribute('data-path');
			const status = this.statusMap.get(path);
			if (!status) continue;

			titleEl.querySelector('.tree-item-inner')?.classList.add(status.colorCls);

			const letter = document.createElement('span');
			letter.className = `publish-status-letter publish-status-fe-letter ${status.colorCls}`;
			letter.textContent = status.letter;
			titleEl.appendChild(letter);
			decorated++;
		}
		console.log('[PublishStatus] decorated:', decorated, 'items');
	}
}

module.exports = PublishStatusPlugin;