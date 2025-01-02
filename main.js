'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    folderToScan: "",
    deleteAfterMove: false,
    dailyNotesFolder: "Daily",
    scheduleTime: "00:00", // Midnight
};
class TaskMoverSettingsTab extends obsidian.PluginSettingTab {
    constructor(plugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Task Mover Settings" });
        new obsidian.Setting(containerEl)
            .setName("Folder to Scan")
            .setDesc("Specify the folder to search for unfinished tasks.")
            .addText((text) => text
            .setPlaceholder("e.g., Tasks")
            .setValue(this.plugin.settings.folderToScan)
            .onChange(async (value) => {
            this.plugin.settings.folderToScan = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName("Daily Notes Folder")
            .setDesc("Specify the folder where your daily notes are located.")
            .addText((text) => text
            .setPlaceholder("e.g., Daily")
            .setValue(this.plugin.settings.dailyNotesFolder)
            .onChange(async (value) => {
            this.plugin.settings.dailyNotesFolder = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName("Delete Original Tasks")
            .setDesc("Delete tasks from the original notes after moving them.")
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.deleteAfterMove)
            .onChange(async (value) => {
            this.plugin.settings.deleteAfterMove = value;
            await this.plugin.saveSettings();
        }));
    }
}
class TaskMover extends obsidian.Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addCommand({
            id: 'move-todos-to-daily-note',
            name: 'Move Unfinished Tasks to Daily Note',
            callback: async () => {
                await this.moveUnfinishedTasks();
            },
        });
        this.addSettingTab(new TaskMoverSettingsTab(this));
        this.addStyles();
    }
    addStyles() {
        const cssLink = document.createElement("link");
        cssLink.rel = "stylesheet";
        cssLink.type = "text/css";
        cssLink.href = this.app.vault.adapter.getResourcePath(`${this.manifest.dir}/styles.css`);
        document.head.appendChild(cssLink);
    }
    async moveUnfinishedTasks() {
        new obsidian.Notice('Processing unfinished tasks...');
        const today = new Date().toISOString().split('T')[0];
        const dailyNotePath = `${this.settings.dailyNotesFolder}/${today}.md`;
        const dailyNoteFile = this.app.vault.getAbstractFileByPath(dailyNotePath);
        const tasksBySource = {};
        const folderToScan = this.settings.folderToScan;
        // Get all markdown files
        const files = this.app.vault
            .getMarkdownFiles()
            .filter((file) => (folderToScan ? file.path.startsWith(folderToScan) : true) &&
            file.path !== dailyNotePath);
        // Process source files
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            let inTaskBlock = false;
            let taskBlock = [];
            let blockKey = null;
            let standaloneTasks = [];
            for (const line of lines) {
                if (line.trim() === 'tasks-start::') {
                    inTaskBlock = true;
                    taskBlock = [];
                    blockKey = null;
                    continue;
                }
                if (inTaskBlock) {
                    if (!blockKey && line.trim().startsWith('##')) {
                        blockKey = line.trim(); // Set the block key as the header
                        continue;
                    }
                    taskBlock.push(line);
                    if (line.trim() === 'tasks-end::') {
                        inTaskBlock = false;
                        if (blockKey) {
                            if (!tasksBySource[file.path]) {
                                tasksBySource[file.path] = { blocks: {}, standaloneTasks: [] };
                            }
                            tasksBySource[file.path].blocks[blockKey] = taskBlock;
                        }
                        taskBlock = [];
                    }
                }
                else {
                    // Capture standalone tasks outside of blocks
                    if (line.trim().startsWith('- [ ]')) {
                        standaloneTasks.push(line.trim());
                    }
                }
            }
            // Add standalone tasks
            if (standaloneTasks.length > 0) {
                if (!tasksBySource[file.path]) {
                    tasksBySource[file.path] = { blocks: {}, standaloneTasks: [] };
                }
                tasksBySource[file.path].standaloneTasks.push(...standaloneTasks);
            }
        }
        let newDailyNoteContent = `# 🗂️Unfinished Tasks\n`;
        let existingBlocks = {};
        if (dailyNoteFile instanceof obsidian.TFile) {
            const dailyNoteContent = await this.app.vault.read(dailyNoteFile);
            // Extract existing blocks from the daily note
            const blockMatches = dailyNoteContent.match(/tasks-start::[\s\S]*?tasks-end::/g);
            if (blockMatches) {
                blockMatches.forEach((block) => {
                    const headerMatch = block.match(/## .+/);
                    const cleanedBlock = block
                        .replace(/^tasks-start::\s*/m, '')
                        .replace(/\s*tasks-end::$/m, '')
                        .replace(/## .+/m, '');
                    if (headerMatch) {
                        const header = headerMatch[0].trim();
                        if (!existingBlocks[header]) {
                            existingBlocks[header] = cleanedBlock.split('\n');
                        }
                    }
                });
            }
            newDailyNoteContent = dailyNoteContent; // Keep existing content
        }
        // Process tasks and update daily note
        for (const [source, taskData] of Object.entries(tasksBySource)) {
            const successfullyTransferred = new Set();
            // Process standalone tasks
            if (taskData.standaloneTasks.length > 0) {
                const header = `## ${source.split('/').pop() || source}`;
                if (existingBlocks[header]) {
                    const existingTasks = existingBlocks[header]
                        .filter((line) => line.trim().startsWith('- [ ]'))
                        .map((task) => task.trim());
                    const newTasks = taskData.standaloneTasks.filter((task) => !existingTasks.includes(task));
                    if (newTasks.length > 0) {
                        const updatedBlock = `tasks-start::\n<div class="task-card">\n${header}${[
                            ...existingBlocks[header].filter((line) => !line.trim().startsWith('- [ ]')),
                            ...existingTasks,
                            ...newTasks,
                        ].join('\n')}\n</div>\ntasks-end::`;
                        newDailyNoteContent = newDailyNoteContent.replace(new RegExp(`tasks-start::\\n<div class="task-card">\\n${header}\\n[\\s\\S]*?tasks-end::`, 'g'), updatedBlock);
                        updatedBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                    }
                }
                else {
                    const newBlock = `tasks-start::\n<div class="task-card">\n${header}\n${taskData.standaloneTasks.join('\n')}\n</div>\ntasks-end::`;
                    newDailyNoteContent += `\n${newBlock}\n`;
                    newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                }
            }
            // Process task blocks
            for (const [blockKey, blockContent] of Object.entries(taskData.blocks)) {
                const cleanedBlockContent = blockContent.filter((line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::'));
                if (existingBlocks[blockKey]) {
                    const existingTasks = existingBlocks[blockKey]
                        .filter((line) => line.trim().startsWith('- [ ]'))
                        .map((task) => task.trim());
                    const newTasks = cleanedBlockContent
                        .filter((line) => line.trim().startsWith('- [ ]'))
                        .filter((task) => !existingTasks.includes(task));
                    if (newTasks.length > 0) {
                        const updatedBlock = `tasks-start::\n<div class="task-card">\n${blockKey}\n${[
                            ...cleanedBlockContent.filter((line) => !newTasks.includes(line.trim()) && !existingBlocks[blockKey].includes(line.trim())),
                            ...existingBlocks[blockKey].filter((line) => !line.trim().startsWith('- [ ]')),
                            ...existingTasks,
                            ...newTasks,
                        ].map((line) => line.replace(/\n/g, '').trim()).join('\n')}\n</div>\ntasks-end::`;
                        newDailyNoteContent = newDailyNoteContent.replace(new RegExp(`tasks-start::\\n<div class="task-card">\\n${blockKey}\\n[\\s\\S]*?tasks-end::`, 'g'), updatedBlock);
                        updatedBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                        console.log(updatedBlock);
                    }
                }
                else {
                    const newBlock = `tasks-start::\n<div class="task-card">\n${blockKey}\n${cleanedBlockContent.join('\n')}\n</div>\ntasks-end::`;
                    newDailyNoteContent += `\n${newBlock}\n`;
                    newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                    console.log(newBlock);
                }
            }
            // Remove tasks only if deleteAfterMove is true
            if (this.settings.deleteAfterMove) {
                const originalFile = this.app.vault.getAbstractFileByPath(source);
                console.log(270);
                console.log(originalFile);
                console.log(successfullyTransferred);
                if (originalFile instanceof obsidian.TFile) {
                    const content = await this.app.vault.read(originalFile);
                    console.log(275);
                    const updatedLines = content
                        .split('\n')
                        .filter((line) => !successfullyTransferred.has(line.trim()));
                    await this.app.vault.modify(originalFile, updatedLines.join('\n'));
                }
            }
        }
        if (dailyNoteFile instanceof obsidian.TFile) {
            await this.app.vault.modify(dailyNoteFile, newDailyNoteContent);
        }
        else {
            await this.app.vault.create(dailyNotePath, newDailyNoteContent);
        }
        new obsidian.Notice('Unfinished tasks moved to today\'s daily note!');
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

module.exports = TaskMover;
//# sourceMappingURL=main.js.map
