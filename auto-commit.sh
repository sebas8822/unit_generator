#!/usr/bin/env bash
# auto-commit.sh — commit & push only if something changed

export PATH="/usr/bin:/usr/local/bin:$PATH"
export VISUAL=nano

# 1 go to the *real* repo
cd /home/sebas_dev_linux/projects/course_generator || exit 1

# # 2 skip run if nothing changed
# git diff-index --quiet HEAD -- && \
# git ls-files --others --exclude-standard --quiet && exit 0

# # 3 avoid more than one auto-commit per day
# last=$(git log -1 --format=%ct 2>/dev/null || echo 0)
# (( $(date +%s) - last < 86400 )) && exit 0

# 4 commit & push
git add -A
git commit -m "chore(auto): snapshot $(date +%F)"
git push origin master

# crontab -e

#┌─ min (0)  hour (20)  day-of-month (*)  month (*)  day-of-week (*)
#0 20 * * *  /home/sebas_dev_linux/projects/course_generator/auto-commit.sh  >> /home/sebas_dev_linux/.auto-commit.log 2>&1
