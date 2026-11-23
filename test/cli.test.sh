#!/usr/bin/env bash
# End-to-end tests for tb.mjs: basic flow, worktrees, parallel writes, sync/merge.
# Usage: bash test/cli.test.sh
set -euo pipefail
TB="$(cd "$(dirname "$0")/.." && pwd)/tb.mjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0
ok()   { pass=$((pass+1)); echo "  ok - $1"; }
die()  { echo "  FAIL - $1"; exit 1; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }
newrepo() { git init -q -b main "$1"; git -C "$1" config user.name T; git -C "$1" config user.email t@t; git -C "$1" commit -q --allow-empty -m init; }

echo "basic flow"
newrepo "$T/a"; cd "$T/a"
node "$TB" init >/dev/null
grep -q "taskboard:start" CLAUDE.md || die "CLAUDE.md block"
node "$TB" add "First" -p high --steps "one; two" -l x,y >/dev/null
node "$TB" start 1 >/dev/null
node "$TB" log 1 "did one" >/dev/null
node "$TB" tick 1 1 >/dev/null
K=$(node "$TB" issue 1 "a question" | sed -E 's/.*#([0-9a-f]+).*/\1/')
[ "$(node "$TB" show 1 --json | json 'j.status')" = in_progress ] || die status
[ "$(node "$TB" show 1 --json | json 'j.steps[0].done')" = true ] || die tick
node "$TB" context | grep -q "issue #$K" || die "context shows issue"
node "$TB" resolve 1 "$K" "answered" >/dev/null
node "$TB" done 1 "finished" >/dev/null
[ "$(node "$TB" show 1 --json | json 'j.status')" = done ] || die done
[ -z "$(git status --porcelain -- . ':!CLAUDE.md')" ] || die "working tree touched"
git show taskboard:board.json | json 'j.tasks.length' | grep -qx 1 || die "board.json"
git show taskboard:BOARD.md | grep -q "First" || die "BOARD.md"
ok "add/start/log/tick/issue/resolve/done; working tree untouched; board.json + BOARD.md written"

echo "worktrees"
git worktree add -q -b feat "$T/a-wt"
(cd "$T/a-wt" && node "$TB" add "From worktree" >/dev/null && node "$TB" start 2 >/dev/null)
[ "$(node "$TB" show 2 --json | json 'j.assignee')" = feat ] || die "worktree shares board"
ok "worktree sees the same board, agent = branch name"

echo "parallel writes"
for i in $(seq 1 15); do node "$TB" log 2 "p$i" >/dev/null & done; wait
[ "$(node "$TB" show 2 --json | json 'j.log.filter(e=>e.msg.startsWith("p")).length')" = 15 ] || die "lost writes"
for i in $(seq 1 6); do node "$TB" add "par $i" >/dev/null & done; wait
[ "$(git show taskboard:board.json | json 'new Set(j.tasks.map(t=>t.id)).size')" = 8 ] || die "duplicate ids"
ok "15 parallel logs and 6 parallel adds, nothing lost, unique IDs"

echo "sync"
git init -q --bare "$T/remote.git"
git remote add origin "$T/remote.git"; git push -q origin main 2>/dev/null
node "$TB" sync >/dev/null
git clone -q "$T/remote.git" "$T/b"; git clone -q "$T/remote.git" "$T/c"
cd "$T/b"; TB_AGENT=B node "$TB" log 2 "from B" >/dev/null; TB_AGENT=B node "$TB" add "B task" >/dev/null; node "$TB" rm 3 >/dev/null
cd "$T/c"; TB_AGENT=C node "$TB" log 2 "from C" >/dev/null; TB_AGENT=C node "$TB" add "C task" >/dev/null
cd "$T/b"; node "$TB" sync >/dev/null
cd "$T/c"; node "$TB" sync | grep -q renumbered || die "collision renumber"
cd "$T/b"; node "$TB" sync >/dev/null
cd "$T/a"; node "$TB" sync >/dev/null
for d in a b c; do git -C "$T/$d" rev-parse taskboard; done | sort -u | wc -l | grep -qx 1 || die "clones converge"
L=$(node "$TB" show 2 --json | json 'j.log.map(e=>e.msg).join("|")')
[[ "$L" == *"from B"* && "$L" == *"from C"* ]] || die "merged logs"
! node "$TB" show 3 >/dev/null 2>&1 || die "deletion survives merge"
ok "fresh clones adopt board; divergent edits merge; ID collision renumbered; delete kept; all converge"

echo "$pass groups passed"
