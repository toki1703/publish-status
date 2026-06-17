'use strict';

var obsidian = require('obsidian');

const VIEW_TYPE_PUBLISH_EXPLORER = 'publish-explorer';

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

// Publish Explorer 用: Publish 上に存在するすべてのファイルのステータスを返す
function resolvePublishStatus(item) {
	if (item.type === 'deleted') {
		return { letter: 'D', colorCls: 'publish-status-deleted' };
	}
	if (item.ctime > 0) {
		if (item.checked) {
			return { letter: 'M', colorCls: 'publish-status-modified' };
		}
		return { letter: null, colorCls: 'publish-status-clean' }; // 変更なし
	}
	return null; // ctime === 0 かつ非削除 → まだ Publish 未反映 (A)
}

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

class PublishExplorerView extends obsidian.ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_PUBLISH_EXPLORER; }
	getDisplayText() { return 'Publish Explorer'; }
	getIcon() { return 'upload-cloud'; }

	async onOpen() {
		this.render();
	}

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
		refreshBtn.addEventListener('click', async () => {
			await this.plugin.refresh();
		});

		const content = container.createDiv({ cls: 'publish-explorer-content' });

		const publishMap = this.plugin.publishMap;
		if (publishMap.size === 0) {
			content.createDiv({ cls: 'publish-explorer-empty', text: 'Publish 上にファイルがありません' });
			return;
		}

		const deletedEntries = [];
		const modifiedEntries = [];
		const cleanEntries = [];

		for (const [path, status] of publishMap) {
			const entry = { path, status };
			if (status.letter === 'D') {
				deletedEntries.push(entry);
			} else if (status.letter === 'M') {
				modifiedEntries.push(entry);
			} else {
				cleanEntries.push(entry);
			}
		}

		const sort = arr => arr.sort((a, b) => a.path.localeCompare(b.path));
		sort(deletedEntries);
		sort(modifiedEntries);
		sort(cleanEntries);

		if (deletedEntries.length > 0) {
			this.renderSection(content, `Publish のみ (D)   ${deletedEntries.length}`, deletedEntries);
		}
		if (modifiedEntries.length > 0) {
			this.renderSection(content, `変更あり (M)   ${modifiedEntries.length}`, modifiedEntries);
		}
		if (cleanEntries.length > 0) {
			this.renderSection(content, `変更なし   ${cleanEntries.length}`, cleanEntries);
		}
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
			const fileRow = container.createDiv({ cls: 'publish-explorer-file-row' });
			fileRow.style.paddingLeft = `${indent + 24}px`;
			fileRow.title = file.path;

			fileRow.createSpan({
				cls: `publish-explorer-file-name ${file.status.colorCls}`,
				text: file.name,
			});

			fileRow.createSpan({
				cls: `publish-status-letter ${file.status.colorCls}`,
				text: file.status.letter,
			});

			if (file.status.letter !== 'D') {
				fileRow.addClass('is-clickable');
				fileRow.addEventListener('click', () => {
					const vaultFile = this.app.vault.getFileByPath(file.path);
					if (vaultFile) {
						this.app.workspace.getLeaf(false).openFile(vaultFile);
					}
				});
			} else {
				fileRow.addClass('publish-explorer-deleted-file');
			}
		}
	}
}

class PublishStatusPlugin extends obsidian.Plugin {
	async onload() {
		this.statusMap = new Map();
		this.publishMap = new Map();

		this.registerView(
			VIEW_TYPE_PUBLISH_EXPLORER,
			(leaf) => new PublishExplorerView(leaf, this)
		);

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

		this.app.workspace.onLayoutReady(async () => {
			await this.refresh();
		});

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.refresh())
		);

		this.registerEvent(
			this.app.vault.on('modify', () => this.refresh())
		);
	}

	onunload() {
		this.clearDecorations();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PUBLISH_EXPLORER);
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
			console.log('[PublishStatus] statusMap:', this.statusMap.size, 'entries');
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
		// .publish-status-fe-letter のみ削除 → Publish Explorer 内の要素に影響しない
		document.querySelectorAll('.publish-status-fe-letter').forEach(el => el.remove());
		document.querySelectorAll('.tree-item-inner[class*="publish-status-"]').forEach(el => {
			el.classList.remove(
				'publish-status-added',
				'publish-status-modified',
				'publish-status-deleted'
			);
		});
	}

	decorate() {
		this.clearDecorations();

		const titleEls = document.querySelectorAll('.tree-item-self[data-path]');
		console.log('[PublishStatus] titleEls found:', titleEls.length);

		let decorated = 0;
		for (const titleEl of titleEls) {
			const path = titleEl.getAttribute('data-path');
			const status = this.statusMap.get(path);
			if (!status) continue;

			const innerEl = titleEl.querySelector('.tree-item-inner');
			if (innerEl) innerEl.classList.add(status.colorCls);

			const letter = document.createElement('span');
			// publish-status-fe-letter でファイルエクスプローラー専用バッジとしてスコープ
			letter.className = `publish-status-letter publish-status-fe-letter ${status.colorCls}`;
			letter.textContent = status.letter;
			titleEl.appendChild(letter);
			decorated++;
		}

		console.log('[PublishStatus] decorated:', decorated, 'items');
	}
}

module.exports = PublishStatusPlugin;
