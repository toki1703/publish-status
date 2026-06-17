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

	// 巨大ファイルは単純な全置換で返す
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
		if (res.status === 200) return res.text;
	} catch (_) { /* 取得失敗 */ }

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

		// ローカルファイルの変更をリアルタイムに反映
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file.path !== this.filePath || this.publishContent === null) return;
			clearTimeout(this._rerenderTimer);
			this._rerenderTimer = setTimeout(() => this._rerenderDiff(), 300);
		}));
	}

	async onClose() {
		clearTimeout(this._rerenderTimer);
	}

    async loadAndRender() {
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
                    const published = await this.plugin.publishFileByPath(this.filePath);
                    if (published) {
                        const reflected = await this.waitForPublishedContent(published.hash);
                        if (reflected) {
                            await this.loadAndRender();
                        } else if (this.bodyEl) {
                            this.bodyEl.empty();
                            this.renderMessage(this.bodyEl, '公開は完了しました。Publish 側の反映後に再読み込みしてください', 'warn');
                        }
                    }
                } finally {
                    uploadBtn.disabled = false;
                }
            });
        }

        this.bodyEl = c.createDiv({ cls: 'publish-diff-body' });
        const loadingEl = this.bodyEl.createDiv({ cls: 'publish-diff-loading', text: 'Publish 版を取得中…' });

        const inst = getPublishInstance(this.plugin.app);
        this.publishContent = inst ? await fetchPublishContent(inst, filePath) : null;
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

		// 方法1: tabHeaderInnerTitleEl への直接書き込み（最優先）
		const titleEl = this.leaf.tabHeaderInnerTitleEl;
		if (titleEl) {
			titleEl.textContent = this.viewTitle;
		}

		// 方法2: view-header-title への直接書き込み
		const headerTitleEl = this.containerEl
			.closest('.workspace-leaf')
			?.querySelector('.view-header-title');
		if (headerTitleEl) {
			headerTitleEl.textContent = this.viewTitle;
		}

		// 方法3: workspace に通知
		this.app.workspace.trigger('layout-change');
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

	async waitForPublishedContent(expectedHash) {
		if (!this.bodyEl || !this.filePath || !expectedHash) return false;
		const inst = getPublishInstance(this.plugin.app);
		if (!inst) return false;

		const delays = [1000, 1500, 2000, 3000, 4000, 5000];
		for (let i = 0; i < delays.length; i++) {
			this.bodyEl.empty();
			this.bodyEl.createDiv({
				cls: 'publish-diff-loading',
				text: `Publish 反映待ち… (${i + 1}/${delays.length})`,
			});

			await sleep(delays[i]);
			const publishContent = await fetchPublishContent(inst, this.filePath, { cacheBust: true });
			if (publishContent !== null && (await sha256Hex(publishContent)) === expectedHash) {
				return true;
			}
		}

		new obsidian.Notice('公開は完了しましたが、Publish 版の反映確認がタイムアウトしました');
		return false;
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

			if (file.status.letter) {
				fileRow.createSpan({
					cls: `publish-status-letter ${file.status.colorCls}`,
					text: file.status.letter,
				});
			}

			// すべてのファイルで Diff パネルを開く
			fileRow.addEventListener('click', () => {
				this.plugin.openDiff(file.path, file.status);
			});

			fileRow.addEventListener('contextmenu', (event) => {
				const action = getPublishAction(file.status.letter);
				if (!action) return;

				event.preventDefault();
				const menu = new obsidian.Menu();
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

		try {
			const content = await this.app.vault.read(file);
			const hash = await sha256Hex(content);
			await uploadPublishMarkdown(inst, file.path, content, hash);
			new obsidian.Notice(`公開しました: ${file.path}`);
			await this.refresh();
			return { hash };
		} catch (e) {
			console.error('[PublishStatus] upload failed', e);
			new obsidian.Notice(`公開に失敗しました: ${e?.message ?? e}`);
			return false;
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
