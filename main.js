'use strict';

var obsidian = require('obsidian');

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

class PublishStatusPlugin extends obsidian.Plugin {
	async onload() {
		this.statusMap = new Map();

		this.addCommand({
			id: 'refresh-publish-status',
			name: 'Refresh Publish Status',
			callback: () => this.refresh(),
		});

		this.addRibbonIcon('upload-cloud', 'Refresh Publish Status', () => this.refresh());

		this.app.workspace.onLayoutReady(async () => {
			await this.refresh();
		});
	}

	onunload() {
		this.clearDecorations();
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
			for (const item of changes) {
				const status = resolveStatus(item);
				if (status) this.statusMap.set(item.path, status);
			}
			console.log('[PublishStatus] statusMap:', this.statusMap.size, 'entries');
			this.decorate();
		} catch (e) {
			console.error('[PublishStatus] scanForChanges failed', e);
			new obsidian.Notice('Publish Status の取得に失敗しました');
		}
	}

	clearDecorations() {
		document.querySelectorAll('.publish-status-letter').forEach(el => el.remove());
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
			letter.className = `publish-status-letter ${status.colorCls}`;
			letter.textContent = status.letter;
			titleEl.appendChild(letter);
			decorated++;
		}

		console.log('[PublishStatus] decorated:', decorated, 'items');
	}
}

module.exports = PublishStatusPlugin;
