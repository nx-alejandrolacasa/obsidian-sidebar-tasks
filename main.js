const { Plugin, BasesView, Keymap, Notice, normalizePath, parsePropertyId, setIcon } = require('obsidian');

const VIEW_TYPE = 'sidebar-task-list';

class TaskListView extends BasesView {
  type = VIEW_TYPE;

  constructor(controller, containerEl) {
    super(controller);
    this.rootEl = containerEl.createDiv('sidebar-tasks');
  }

  onDataUpdated() {
    const statusId = this.config.getAsPropertyId('statusProperty') ?? 'note.status';
    const openValues = this.getListOption('openValues', ['To do']);
    const inProgressValues = this.getListOption('inProgressValues', ['In progress']);
    const doneValues = this.getListOption('doneValues', ['Done']);
    const completedId = this.config.getAsPropertyId('completedProperty') ?? 'note.completed';
    const statusOf = (entry) => entry.getValue(statusId)?.toString();
    const isDone = (entry) => doneValues.includes(statusOf(entry));
    const knownStatuses = new Set([...openValues, ...inProgressValues, ...doneValues]);
    const hasKnownStatus = (entry) => knownStatuses.has(statusOf(entry));
    const hiddenProps = new Set(['file.name']);
    const hideDone = this.config.get('hideDone') === true;
    const chipOptions = {
      showLabels: this.config.get('showLabels') === true,
      relativeDates: this.config.get('dateFormat') !== 'absolute',
      renderContext: this.app.renderContext,
    };

    const setStatus = (entry, status) =>
      this.app.fileManager.processFrontMatter(entry.file, (fm) => {
        fm[parsePropertyId(statusId).name] = status;
        const completedKey = parsePropertyId(completedId).name;
        if (doneValues.includes(status)) fm[completedKey] ??= new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        else delete fm[completedKey];
      });
    const toggle = (entry) => setStatus(entry, isDone(entry) ? openValues[0] : doneValues[0]);

    const groupStatus = (group) => {
      const key = group.hasKey() ? group.key.toString() : null;
      return key && group.entries.every((entry) => statusOf(entry) === key) ? key : null;
    };
    const keepEmptyGroups = this.config.get('keepEmptyGroups') === true;
    const groupSections = this.data.groupedData.map((group) => ({
      title: group.hasKey() ? group.key.toString() : null,
      entries: group.entries.filter((entry) => hasKnownStatus(entry) && !(hideDone && isDone(entry))),
      dropStatus: groupStatus(group),
    }));
    const sections = [
      { title: 'Unknown status', entries: this.data.data.filter((entry) => !hasKnownStatus(entry)), isUnknown: true },
      ...orderByConfiguredStatus(groupSections, [...knownStatuses]),
    ];

    this.rootEl.empty();
    this.dropTargets = [];

    for (const { title, entries, dropStatus, isUnknown } of sections) {
      const keepEmpty = keepEmptyGroups && title && !isUnknown;
      if (entries.length === 0 && !keepEmpty) continue;
      const sectionEl = title ? this.renderCollapsibleSection(title, entries.length) : this.rootEl;
      if (dropStatus) {
        this.makeDropTarget(sectionEl, {
          accepts: (entry) => statusOf(entry) !== dropStatus,
          onDrop: (entry) => setStatus(entry, dropStatus),
        });
      }
      const list = sectionEl.createEl('ul', 'sidebar-tasks-list');
      for (const entry of entries) {
        const done = isDone(entry);
        const status = statusOf(entry);
        const row = list.createEl('li', { cls: done ? 'sidebar-tasks-row is-done' : 'sidebar-tasks-row' });
        this.makeDraggable(row, entry);
        const checkbox = row.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox', attr: { title: status || 'No status' } });
        checkbox.checked = done;
        checkbox.indeterminate = inProgressValues.includes(status);
        checkbox.onchange = () => toggle(entry);

        const body = row.createDiv('sidebar-tasks-body');
        const title = body.createSpan({ cls: 'sidebar-tasks-title', text: entry.file.basename, attr: { title: 'Click to rename' } });
        title.onclick = () => this.startRename(title, row, entry.file);

        const meta = body.createDiv('sidebar-tasks-meta');
        meta.onclick = (evt) => this.openClickedLink(evt, entry.file.path);
        for (const prop of this.config.getOrder()) {
          if (hiddenProps.has(prop)) continue;
          const value = entry.getValue(prop);
          if (!value?.isTruthy()) continue;
          const label = chipOptions.showLabels ? this.config.getDisplayName(prop) : null;
          renderChip(meta, value, { ...chipOptions, label, canBeOverdue: !done });
        }

        const actions = row.createDiv('sidebar-tasks-actions');
        addIconButton(actions, 'link', 'Open task', (evt) =>
          this.app.workspace.openLinkText(entry.file.path, '', Keymap.isModEvent(evt)));
        addIconButton(actions, 'trash-2', 'Delete task', () => this.app.fileManager.trashFile(entry.file));
      }
    }
  }

  renderCollapsibleSection(title, count) {
    const collapsed = new Set(this.getListOption('collapsedSections', []));
    const section = this.rootEl.createEl('details', 'sidebar-tasks-section');
    const isEmpty = count === 0;
    section.open = !isEmpty && !collapsed.has(title);

    const header = section.createEl('summary', 'sidebar-tasks-group');
    setIcon(header.createSpan('sidebar-tasks-chevron'), 'chevron-right');
    header.createSpan({ cls: 'sidebar-tasks-group-title', text: title });
    header.createSpan({ cls: 'sidebar-tasks-count', text: String(count) });

    section.ontoggle = () => {
      if (isEmpty || section.open !== collapsed.has(title)) return;
      if (section.open) collapsed.delete(title);
      else collapsed.add(title);
      this.config.set('collapsedSections', [...collapsed]);
    };
    return section;
  }

  openClickedLink(evt, sourcePath) {
    const link = evt.target.closest('a.internal-link');
    if (!link || evt.defaultPrevented) return;
    evt.preventDefault();
    evt.stopPropagation();
    const linktext = link.dataset.href ?? link.getAttr('href');
    const folder = this.app.vault.getFolderByPath(normalizePath(linktext));
    if (folder) return this.app.internalPlugins?.getEnabledPluginById('file-explorer')?.revealInFolder(folder);
    this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
  }

  startRename(titleEl, row, file) {
    if (titleEl.isContentEditable) return;
    row.draggable = false;
    titleEl.contentEditable = 'plaintext-only';
    titleEl.focus();
    titleEl.win.getSelection().selectAllChildren(titleEl);

    const finish = async (save) => {
      titleEl.onkeydown = titleEl.onblur = null;
      titleEl.contentEditable = 'false';
      row.draggable = true;
      const name = titleEl.textContent.trim();
      if (!save || !name || name === file.basename) return titleEl.setText(file.basename);
      try {
        await this.app.fileManager.renameFile(file, normalizePath(`${file.parent?.path ?? ''}/${name}.${file.extension}`));
      } catch (err) {
        new Notice(`Couldn't rename task: ${err.message}`);
        titleEl.setText(file.basename);
      }
    };
    titleEl.onkeydown = (evt) => {
      if (evt.key !== 'Enter' && evt.key !== 'Escape') return;
      evt.preventDefault();
      evt.stopPropagation();
      finish(evt.key === 'Enter');
    };
    titleEl.onblur = () => finish(true);
  }

  makeDraggable(row, entry) {
    row.draggable = true;
    row.ondragstart = (evt) => {
      evt.stopPropagation();
      this.draggedEntry = entry;
      evt.dataTransfer.effectAllowed = 'move';
      evt.dataTransfer.setData('text/plain', entry.file.path);
      row.addClass('is-dragging');
      for (const target of this.dropTargets) target.sectionEl.toggleClass('is-droppable', target.accepts(entry));
    };
    row.ondragend = () => {
      this.draggedEntry = null;
      row.removeClass('is-dragging');
      for (const { sectionEl } of this.dropTargets) sectionEl.removeClass('is-droppable', 'is-drop-target');
    };
  }

  makeDropTarget(sectionEl, { accepts, onDrop }) {
    this.dropTargets.push({ sectionEl, accepts });
    const canDropHere = () => this.draggedEntry && accepts(this.draggedEntry);
    sectionEl.ondragenter = sectionEl.ondragover = (evt) => {
      if (!canDropHere()) return;
      evt.preventDefault();
      evt.stopPropagation();
      evt.dataTransfer.dropEffect = 'move';
      sectionEl.addClass('is-drop-target');
    };
    sectionEl.ondragleave = (evt) => {
      if (!sectionEl.contains(evt.relatedTarget)) sectionEl.removeClass('is-drop-target');
    };
    sectionEl.ondrop = (evt) => {
      if (!canDropHere()) return;
      evt.preventDefault();
      evt.stopPropagation();
      onDrop(this.draggedEntry);
    };
  }

  getListOption(key, fallback) {
    const values = this.config.get(key);
    return Array.isArray(values) && values.length > 0 ? values : fallback;
  }
}

function orderByConfiguredStatus(sections, statuses) {
  const keyed = sections.filter((section) => section.title);
  if (keyed.length === 0 || !keyed.every((section) => section.dropStatus)) return sections;
  const sectionByStatus = new Map(keyed.map((section) => [section.title, section]));
  return statuses.map((status) => sectionByStatus.get(status) ?? { title: status, entries: [], dropStatus: status });
}

function addIconButton(parent, icon, label, onClick) {
  const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
  setIcon(button, icon);
  button.onclick = onClick;
}

function renderChip(parent, value, { label, relativeDates, canBeOverdue, renderContext }) {
  const chip = parent.createSpan('sidebar-tasks-chip');
  if (label) chip.createSpan({ cls: 'sidebar-tasks-chip-label', text: label });
  const valueEl = chip.createSpan();
  if (typeof value.relative !== 'function') return value.renderTo(valueEl, renderContext);
  valueEl.setText(relativeDates ? value.relative() : value.toString());
  chip.setAttr('title', value.toString());
  if (canBeOverdue && new Date(value.toString()) < startOfToday()) chip.addClass('is-overdue');
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

module.exports = class SidebarTasksPlugin extends Plugin {
  onload() {
    this.registerBasesView(VIEW_TYPE, {
      name: 'Task list',
      icon: 'list-checks',
      factory: (controller, containerEl) => new TaskListView(controller, containerEl),
      options: () => [
        {
          type: 'group',
          displayName: 'Display',
          items: [
            { type: 'toggle', key: 'hideDone', displayName: 'Hide done tasks', default: false },
          { type: 'toggle', key: 'keepEmptyGroups', displayName: 'Keep empty groups', default: false },
            { type: 'toggle', key: 'showLabels', displayName: 'Show property names', default: false },
            {
              type: 'dropdown',
              key: 'dateFormat',
              displayName: 'Dates',
              default: 'relative',
              options: { relative: 'Relative (in 3 days)', absolute: 'Absolute (2026-10-04)' },
            },
          ],
        },
        {
          type: 'group',
          displayName: 'Task status',
          items: [
            { type: 'property', key: 'statusProperty', displayName: 'Status property', default: 'note.status' },
            { type: 'multitext', key: 'openValues', displayName: 'Open statuses', default: ['To do'] },
            { type: 'multitext', key: 'inProgressValues', displayName: 'In progress statuses', default: ['In progress'] },
            { type: 'multitext', key: 'doneValues', displayName: 'Done statuses', default: ['Done'] },
            { type: 'property', key: 'completedProperty', displayName: 'Completed date property', default: 'note.completed' },
          ],
        },
      ],
    });

    this.addCommand({
      id: 'open-base-in-sidebar',
      name: 'Open current base in right sidebar',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== 'base') return false;
        if (!checking) this.openInSidebar(file);
        return true;
      },
    });
  }

  async openInSidebar(file) {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.openFile(file);
    await this.app.workspace.revealLeaf(leaf);
  }
};
