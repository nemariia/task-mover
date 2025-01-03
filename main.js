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
            existingBlocks = this.parseDailyNoteContent(dailyNoteContent);
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
                        const updatedBlock = `tasks-start::\n${header}${[
                            ...existingBlocks[header].filter((line) => !line.trim().startsWith('- [ ]')),
                            ...existingTasks,
                            ...newTasks,
                        ].join('\n')}\ntasks-end::`;
                        newDailyNoteContent = newDailyNoteContent.replace(new RegExp(`tasks-start::\\n${header}\\n[\\s\\S]*?tasks-end::`, 'g'), updatedBlock);
                        updatedBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                    }
                }
                else {
                    const newBlock = `tasks-start::\n${header}\n${taskData.standaloneTasks.join('\n')}\ntasks-end::`;
                    newDailyNoteContent += `\n${newBlock}\n`;
                    newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                }
            }
            // Process task blocks
            for (const [blockKey, blockContent] of Object.entries(taskData.blocks)) {
                const cleanedBlockContent = blockContent.filter((line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::'));
                if (existingBlocks[blockKey]) {
                    const updatedBlock = this.combineBlocks(blockKey, existingBlocks[blockKey], blockContent);
                    newDailyNoteContent = newDailyNoteContent.replace(new RegExp(`tasks-start::\\n${blockKey}\\n[\\s\\S]*?tasks-end::`, 'g'), updatedBlock.join('\n'));
                    updatedBlock.forEach((el) => successfullyTransferred.add(el.trim()));
                }
                else {
                    const newBlock = `tasks-start::\n${blockKey}\n${cleanedBlockContent.join('\n')}\ntasks-end::`;
                    newDailyNoteContent += `\n${newBlock}\n`;
                    newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
                }
            }
            // Remove tasks only if deleteAfterMove is true
            if (this.settings.deleteAfterMove) {
                const originalFile = this.app.vault.getAbstractFileByPath(source);
                if (originalFile instanceof obsidian.TFile) {
                    const content = await this.app.vault.read(originalFile);
                    const updatedLines = content
                        .split('\n')
                        .filter((line) => !successfullyTransferred.has(line.trim()));
                    await this.app.vault.modify(originalFile, updatedLines.join('\n'));
                }
            }
        }
        let newBlocks = this.parseDailyNoteContent(newDailyNoteContent);
        const combinedTasks = {};
        for (const [header, block] of Object.entries(newBlocks)) {
            if (!combinedTasks[header]) {
                combinedTasks[header] = [];
            }
            combinedTasks[header] = this.combineBlocks(header, combinedTasks[header], block);
        }
        console.log(258);
        console.log(combinedTasks);
        console.log(newDailyNoteContent);
        for (const [header, block] of Object.entries(combinedTasks)) {
            // Regular expression to find the block
            const regex = new RegExp(`tasks-start::\\n${header}\\n[\\s\\S]*?tasks-end::`, 'g');
            console.log(header);
            // First, we'll find all matches and count them
            const matches = [...newDailyNoteContent.matchAll(regex)];
            console.log(266);
            console.log(newDailyNoteContent);
            console.log(matches);
            if (matches.length > 0) {
                // Replace the first occurrence with the updated content
                newDailyNoteContent = newDailyNoteContent.replace(matches[0][0], block.join('\n'));
                // If more than one match, remove all subsequent ones
                if (matches.length > 1) {
                    matches.slice(1).forEach(match => {
                        newDailyNoteContent = newDailyNoteContent.replace(match[0], '');
                    });
                }
            }
        }
        console.log(282);
        console.log(newDailyNoteContent);
        if (dailyNoteFile instanceof obsidian.TFile) {
            await this.app.vault.modify(dailyNoteFile, newDailyNoteContent);
        }
        else {
            await this.app.vault.create(dailyNotePath, newDailyNoteContent);
        }
        new obsidian.Notice('Unfinished tasks moved to today\'s daily note!');
    }
    parseDailyNoteContent(dailyNoteContent) {
        let existingBlocks = {};
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
                        existingBlocks[header] = []; // Initialize the array if it does not exist
                    }
                    existingBlocks[header] = [...existingBlocks[header], ...cleanedBlock.split('\n')];
                }
            });
        }
        return existingBlocks;
    }
    combineBlocks(blockKey, acc, block) {
        const cleanedBlock = block.filter((line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::') && line.trim() !== blockKey);
        acc = acc.filter((line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::') && line.trim() !== blockKey);
        const combinedContent = [...acc, ...cleanedBlock];
        const uniqueContent = Array.from(new Set(combinedContent.map((line) => line.trim())));
        const updatedBlock = [
            'tasks-start::',
            blockKey,
            ...uniqueContent,
            'tasks-end::'
        ].map((line) => line.replace(/\n/g, '').trim());
        return updatedBlock;
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
}

module.exports = TaskMover;
//# sourceMappingURL=main.js.map
