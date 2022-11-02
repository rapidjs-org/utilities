#!/bin/bash

git add .
git commit -m "Outsource shared utility scripts"
git reset --soft HEAD~1
git commit --amend --no-edit
git push --force