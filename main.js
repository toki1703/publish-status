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

async function fetchPublishContent(inst, path) {
	const host = inst?.host;
	const siteId = inst?.siteId;
	if (!host || !siteId) return null;

	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	try {
		const res = await obsidian.requestUrl({
			url: `https://${host}/access/${siteId}/${encodedPath}`,
		});
		if (res.status === 200) return res.text;
	} catch (_) { /* 取得失敗 */ }

	return null;
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
	}

	getViewType() { return VIEW_TYPE_PUBLISH_DIFF; }
	getDisplayText() {
		const name = this.filePath?.split('/').pop() ?? 'Publish Diff';
		const p = this.publishHash ?? '-------';
		const l = this.localHash   ?? '-------';
		return `${name} (${p}) ↔ ${name} (${l})`;
	}
	getIcon() { return 'git-compare'; }

	async setState(state, result) {
		this.filePath = state.path ?? null;
		this.statusLetter = state.statusLetter ?? null;
		await super.setState(state, result);
		if (this.filePath) await this.loadAndRender();
	}

	getState() {
		return { path: this.filePath, statusLetter: this.statusLetter };
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
		const c = this.containerEl.children[1];
		c.empty();
		c.addClass('publish-diff-container');

		const { filePath, statusLetter } = this;

		// ファイル切り替え時に前のハッシュをリセット
		this.publishHash = null;
		this.localHash   = null;

		const header = c.createDiv({ cls: 'publish-diff-header' });
		const colorCls = { D: 'publish-status-deleted', M: 'publish-status-modified', A: 'publish-status-added' }[statusLetter] ?? 'publish-status-clean';
		header.createSpan({ cls: `publish-diff-badge ${colorCls}`, text: statusLetter ?? '?' });
		this.headerTitleEl = header.createSpan({ cls: 'publish-diff-title' });
		this._updateHeaderTitle();
		this._forceTabTitleUpdate();

		this.bodyEl = c.createDiv({ cls: 'publish-diff-body' });
		const loadingEl = this.bodyEl.createDiv({ cls: 'publish-diff-loading', text: 'Publish 版を取得中…' });

		const inst = this.plugin.app.internalPlugins?.plugins?.['publish']?.instance;
		this.publishContent = inst ? await fetchPublishContent(inst, filePath) : null;

		let localContent = null;
		if (statusLetter !== 'D') {
			const vaultFile = this.app.vault.getFileByPath(filePath);
			if (vaultFile) localContent = await this.app.vault.read(vaultFile);
		}

		this.publishHash = await this._contentHash(this.publishContent);
		this.localHash   = await this._contentHash(localContent);

		loadingEl.remove();
		this._renderDiff(localContent);
		this._updateHeaderTitle();
		this._forceTabTitleUpdate();
	}

	_updateHeaderTitle() {
		if (!this.headerTitleEl || !this.filePath) return;
		const name = this.filePath.split('/').pop();
		const p = this.publishHash ?? '-------';
		const l = this.localHash   ?? '-------';
		this.headerTitleEl.setText(`${name} (${p}) ↔ ${name} (${l})`);
	}

	_forceTabTitleUpdate() {
		this.leaf.updateHeader?.();
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

		if (this.publishContent !== null && localContent !== null) {
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
		this._updateHeaderTitle();
		this._forceTabTitleUpdate();
	}

	async _contentHash(content) {
		if (!content) return null;
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 7);
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

		const publishMap = this.plugin.publishMap;
		if (publishMap.size === 0) {
			content.createDiv({ cls: 'publish-explorer-empty', text: 'Publish 上にファイルがありません' });
			return;
		}

		const deletedEntries = [], modifiedEntries = [], cleanEntries = [];
		for (const [path, status] of publishMap) {
			const entry = { path, status };
			if (status.letter === 'D') deletedEntries.push(entry);
			else if (status.letter === 'M') modifiedEntries.push(entry);
			else cleanEntries.push(entry);
		}

		const sort = arr => arr.sort((a, b) => a.path.localeCompare(b.path));
		sort(deletedEntries); sort(modifiedEntries); sort(cleanEntries);

		if (deletedEntries.length > 0)
			this.renderSection(content, `Publish のみ (D)   ${deletedEntries.length}`, deletedEntries);
		if (modifiedEntries.length > 0)
			this.renderSection(content, `変更あり (M)   ${modifiedEntries.length}`, modifiedEntries);
		if (cleanEntries.length > 0)
			this.renderSection(content, `変更なし   ${cleanEntries.length}`, cleanEntries, false);
	}

	renderSection(container, title, entries, startCollapsed = false) {
		const section = container.createDiv({ cls: 'publish-explorer-section' });

		const sectionHeader = section.createDiv({ cls: 'publish-explorer-section-header' });
		const chevron = sectionHeader.createSpan({ cls: 'publish-explorer-chevron' });
		obsidian.setIcon(chevron, startCollapsed ? 'chevron-right' : 'chevron-down');
		sectionHeader.createSpan({ cls: 'publish-explorer-section-title', text: title });

		const sectionContent = section.createDiv({ cls: 'publish-explorer-section-content' });
		if (startCollapsed) sectionContent.addClass('is-collapsed');
		this.renderTree(sectionContent, buildTree(entries), 0);

		sectionHeader.addEventListener('click', () => {
			const collapsed = sectionContent.hasClass('is-collapsed');
			if (collapsed) {
				sectionContent.removeClass('is-collapsed');
				obsidian.setIcon(chevron, 'chevron-down');
			} else {
				sectionContent.addClass('is-collapsed');
				obsidian.setIcon(chevron, 'chevron-right');
			}
		});
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
		// Diff タブはシングルトン: 既存があれば更新、なければ新規作成してピン止め
		const diffLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISH_DIFF);
		let diffLeaf = diffLeaves[0] ?? null;

		if (diffLeaf) {
			await diffLeaf.setViewState({
				type: VIEW_TYPE_PUBLISH_DIFF,
				state: { path, statusLetter: status.letter },
			});
			this.app.workspace.revealLeaf(diffLeaf);
		} else {
			diffLeaf = this.app.workspace.getLeaf('tab');
			await diffLeaf.setViewState({
				type: VIEW_TYPE_PUBLISH_DIFF,
				state: { path, statusLetter: status.letter },
				active: true,
			});
			diffLeaf.setPinned(true);
			this.fileLeaf = null;
		}

		// 実ファイルも同様にシングルトン: 既存ペインを更新、なければ垂直分割
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
		const inst = this.app.internalPlugins?.plugins?.['publish']?.instance;
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
