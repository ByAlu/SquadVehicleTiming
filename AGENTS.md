# Project Instructions

## Setup
- Init a git if does not exist

## General Rules
- Always respond in English.
- Before modifying code, inspect the relevant files.
- Follow the existing code style.
- Do not modify unrelated files.
- Prefer simple solutions over complex abstractions.
- Before starting changes display current branches and ask for which branch should switch or create new branch
- After changes commit changes and ask for commit message.

## Workflow
- Before making changes, explain the implementation plan.
- After modifying code, check for compilation errors.
- Do not introduce new dependencies without permission.
- Summarize all modifications at the end.

## Git Commit Workflow
- When I request a commit, automatically stage all changes using `git add -A`.
- Do not ask me to stage files manually.
- Ask me only for the commit message if I haven't provided one.
- Once I provide the commit message, execute `git commit -m "<message>"`.
- Do not ask for additional confirmation unless necessary.
- After committing, report the commit hash and status.