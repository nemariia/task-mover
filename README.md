# Task Mover Plugin

## Description
Task Mover is a dynamic plugin designed to gather all your unfinished tasks in one place. It automatically locates unfinished tasks across your notes and consolidates them into a single daily note, ensuring you never lose track of your pending activities. It will group the tasks by the original file or by topic. It can also gather the surrounding information and move it together with the tasks.

## Configuration
   - The available settings:
     - **Folder to Scan:** Specify the folder where the plugin should search for tasks.
     - **Daily Notes Folder:** Define where the tasks should be moved.
     - **Delete Original Tasks:** Choose whether to delete tasks from the original notes after moving them.

## Usage
   - Use the command `Move Unfinished Tasks to Daily Note` to execute the task consolidation process.
   - Tasks will be moved to the designated daily note.

This plugin does not require you to type any queries or code. You can use simple tasks (- [ ]) or use task blocks to preserve context:

```
tasks-start::
## Tasks Header
Details and context here
- [ ] Task1
- [ ] Task2
tasks-end::
```

If you have several task blocks across your notes with the same topic, it will combine them into one block:

Note 1

```
tasks-start::
## Buy
- [ ] Pasta
- [ ] Bread
tasks-end::
```

Note 2

```tasks-start::
## Buy
- [ ] Juice
- [ ] Bread
tasks-end::
```

Result in the daily note

```
tasks-start::
## Buy
- [ ] Pasta
- [ ] Bread
- [ ] Juice
tasks-end::
```

## ⚠️ Be careful!
If the **Delete Original Tasks** is on, it will remove the unfinished tasks from the original notes. Turn it on only if this is what you intend to to.

## Advantages
- **Automated Task Consolidation:** Task Mover automates the movement of tasks into a single note, reducing the manual effort of tracking tasks across various notes.
- **Context Preservation:** Maintains the context surrounding each task by using task blocks, which allows grouping by topic or the original note.
- **Customization Options:** Task Mover allows to choose the specific folder to scan and the option to delete tasks post-movement.
- **Focus on Task Management:** Task Mover is specifically designed for task management.

TODO:
- Allow scheduling task movement automatically
