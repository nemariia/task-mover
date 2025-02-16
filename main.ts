import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, normalizePath, TFolder, TextComponent, AbstractInputSuggest } from "obsidian";

interface PluginSettings {
  folderToScan: string;
  deleteAfterMove: boolean;
  dailyNotesFolder: string;
  scheduleTime: string;
}
  
const DEFAULT_SETTINGS: PluginSettings = {
  folderToScan: "",
  deleteAfterMove: false,
  dailyNotesFolder: "Daily",
  scheduleTime: "00:00", // Midnight
};

type TaskData = {
  blocks: Record<string, string[]>;
  standaloneTasks: string[];
};

type TasksBySource = Record<string, TaskData>;

interface CombinedTasks {
  [key: string]: string[];
}


// Folder suggestion for settings
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  getSuggestions(inputStr: string): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file) => file instanceof TFolder && file.path.toLowerCase().includes(inputStr.toLowerCase())) as TFolder[];
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.dispatchEvent(new Event("input"));
  }
}


class TaskMoverSettingsTab extends PluginSettingTab {
  plugin: TaskMover;

  constructor(plugin: TaskMover) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Folder to scan")
      .setDesc("Specify the folder to search for unfinished tasks.")
      .addText((text) => {
        text.setPlaceholder("e.g., Tasks")
          .setValue(this.plugin.settings.folderToScan)
          .onChange(async (value) => {
            this.plugin.settings.folderToScan = value;
            await this.plugin.saveSettings();
          });

        new FolderSuggest(this.app, text.inputEl);
      });

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Specify the folder where your daily notes are located.")
      .addText((text) => {
        text
          .setPlaceholder("e.g., Daily")
          .setValue(this.plugin.settings.dailyNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyNotesFolder = value;
            await this.plugin.saveSettings();
          });

          new FolderSuggest(this.app, text.inputEl);
        });

    new Setting(containerEl)
      .setName("Delete original tasks")
      .setDesc("Delete tasks from the original notes after moving them.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteAfterMove)
          .onChange(async (value) => {
            this.plugin.settings.deleteAfterMove = value;
            await this.plugin.saveSettings();
          })
      );
  }
}


export default class TaskMover extends Plugin {
  settings!: PluginSettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addCommand({
      id: 'move-todos-to-daily-note',
      name: 'Move unfinished tasks to daily note',
      callback: async () => {
        await this.moveUnfinishedTasks();
      },
    });
    this.addSettingTab(new TaskMoverSettingsTab(this));
  }

  async moveUnfinishedTasks() {
    new Notice('Processing unfinished tasks...');

    const today = new Date().toISOString().split('T')[0];
    const dailyNotePath = normalizePath(`${this.settings.dailyNotesFolder}/${today}.md`);
    let dailyNoteFile = this.app.vault.getAbstractFileByPath(dailyNotePath);

    let tasksBySource: TasksBySource = {};
    tasksBySource = await this.collectTasks(dailyNotePath);

    // If the Daily Note doesn't exist
    let newDailyNoteContent = `# 🗂️Unfinished Tasks\n`;
    
    let existingBlocks: Record<string, string[]> = {};
    if (dailyNoteFile instanceof TFile) {
      const dailyNoteContent = await this.app.vault.read(dailyNoteFile);
      // Extract existing blocks from the daily note
      existingBlocks = dailyNoteFile
      ? this.parseDailyNoteContent(dailyNoteContent)
      : {};
      newDailyNoteContent = dailyNoteContent; // Keep existing content
    }
    else {
      // Create the daily note if doesn't exist
      await this.app.vault.create(dailyNotePath, newDailyNoteContent);
      dailyNoteFile = this.app.vault.getAbstractFileByPath(dailyNotePath);
    }

    // Process tasks and update daily note
    for (const [source, taskData] of Object.entries(tasksBySource)) {
      const successfullyTransferred = new Set<string>();

      // Process standalone tasks
      if (taskData.standaloneTasks.length > 0) {
        const header = `## ${source.split('/').pop() || source}`;
        if (existingBlocks[header]) {
          const existingTasks = existingBlocks[header]
            .filter((line) => line.trim().startsWith('- [ ]'))
            .map((task) => task.trim());

          const newTasks = taskData.standaloneTasks.filter(
            (task) => !existingTasks.includes(task)
          );

          if (newTasks.length > 0) {
            const updatedBlock = `tasks-start::\n${header}${[
              ...existingBlocks[header].filter((line) => !line.trim().startsWith('- [ ]')),
              ...existingTasks,
              ...newTasks,
            ].join('\n')}\ntasks-end::`;
            newDailyNoteContent = newDailyNoteContent.replace(
              new RegExp(`tasks-start::\\n${header}\\n[\\s\\S]*?tasks-end::`, 'g'),
              updatedBlock
            );
            updatedBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
          }
        } else {
			  const newBlock = `tasks-start::\n${header}\n${taskData.standaloneTasks.join('\n')}\ntasks-end::`;
			  newDailyNoteContent += `\n${newBlock}\n`;
			  newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
        }
      }

      // Process task blocks
      for (const [blockKey, blockContent] of Object.entries(taskData.blocks)) {
        const cleanedBlockContent = blockContent.filter(
          (line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::')
        );

        if (existingBlocks[blockKey]) {
		      const updatedBlock = this.combineBlocks(blockKey, existingBlocks[blockKey], blockContent);
          newDailyNoteContent = newDailyNoteContent.replace(
            new RegExp(`tasks-start::\\n${blockKey}\\n[\\s\\S]*?tasks-end::`, 'g'),
            updatedBlock.join('\n')
          );
          updatedBlock.forEach((el) => successfullyTransferred.add(el.trim()));
        } else {
			    const newBlock = `tasks-start::\n${blockKey}\n${cleanedBlockContent.join('\n')}\ntasks-end::`;
			    newDailyNoteContent += `\n${newBlock}\n`;
			    newBlock.split('\n').forEach((el) => successfullyTransferred.add(el.trim()));
        }
      }

      let newBlocks = this.parseDailyNoteContent(newDailyNoteContent);
	    const combinedTasks: CombinedTasks = {};

	    for (const [header, block] of Object.entries(newBlocks)) {

		    if (!combinedTasks[header]) {
			    combinedTasks[header] = [];
		    }
		    combinedTasks[header] = this.combineBlocks(header, combinedTasks[header], block);
	    }

	    for (const [header, block] of Object.entries(combinedTasks)) {
		    // Regular expression to find the block
		    const regex = new RegExp(`tasks-start::\\n${header}\\n[\\s\\S]*?tasks-end::`, 'g');
		
		    // First, we'll find all matches and count them
		    const matches = [...newDailyNoteContent.matchAll(regex)];

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

	    try {
        if (dailyNoteFile instanceof TFile) {
          await this.app.vault.process(dailyNoteFile, data => {
            return newDailyNoteContent;
          });
        } else {
          throw Error("Something went wrong, and the daily note wasn't created");
        }

        // Remove tasks only if deleteAfterMove is true
        if (this.settings.deleteAfterMove) {
          const originalFile = this.app.vault.getAbstractFileByPath(source);
          if (originalFile instanceof TFile) {
            const content = await this.app.vault.read(originalFile);
            const updatedLines = content
              .split('\n')
              .filter((line) => !successfullyTransferred.has(line.trim()));
            await this.app.vault.process(originalFile, data => {
              return updatedLines.join('\n')
            });
          }
        }
        new Notice('Unfinished tasks moved to today\'s daily note!');
      }
      catch (error: any) {
        console.error("An unexpected error occurred:", error);
        new Notice("An error occurred while processing the daily note. Check the console for details.");
      }
    }
  }
  
  parseDailyNoteContent(dailyNoteContent: string) {
	  let existingBlocks: Record<string, string[]> = {};
	  const blockMatches = dailyNoteContent.match(/tasks-start::[\s\S]*?tasks-end::/g);
    if (blockMatches) {
        blockMatches.forEach((block: string) => {
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

  async collectTasks(dailyNotePath: string) {
    const tasksBySource: TasksBySource = {};
    const folderToScan = this.settings.folderToScan;

    // Get all markdown files
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) =>
        (folderToScan ? file.path.startsWith(folderToScan) : true) &&
        file.path !== dailyNotePath
      );

    // Process source files
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split('\n');

      let inTaskBlock = false;
      let taskBlock: string[] = [];
      let blockKey: string | null = null;
      let standaloneTasks: string[] = [];

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

          if (line.trim().startsWith('- [x]')) {
            continue;
          }
          taskBlock.push(line);

          if (line.trim() === 'tasks-end::') {
            inTaskBlock = false;
            if (!tasksBySource[file.path]) {
              tasksBySource[file.path] = { blocks: {}, standaloneTasks: [] };
            }
            if (this.hasUnfinishedTasks(taskBlock)) {
              // If the block has a header
              if (blockKey) {
                tasksBySource[file.path].blocks[blockKey] = taskBlock;
              }
              // If no header
              else {
                tasksBySource[file.path].blocks[file.basename] = taskBlock;
              }
            }
            taskBlock = [];
          }
        } else {
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
    return tasksBySource;
  }
  
  hasUnfinishedTasks(blockContent: string[]): boolean {
    const unfinishedTaskRegex = /^\s*-\s\[ \]/; // Matches lines that start with "- [ ]" (ignoring leading spaces)
    return blockContent.some((line) => unfinishedTaskRegex.test(line));
  }  

  combineBlocks(blockKey: string, acc: string[], block: string[]) {
	  const cleanedBlock = block.filter(
      (line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::') && line.trim() !== blockKey
    );
	
	  acc = acc.filter(
      (line) => !line.trim().startsWith('tasks-start::') && !line.trim().startsWith('tasks-end::') && line.trim() !== blockKey 
    );

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
