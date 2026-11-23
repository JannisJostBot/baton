"""Browser test for the GitHub Pages board against test/mock-github.mjs.

Serves docs/index.html from one origin and the mock API from another (like real
Pages + api.github.com), then checks read-only viewing, editing with a token,
CLI <-> web round trips, concurrent writers and old boards without board.json.

Usage: python3 test/pages.test.py   (needs: node, git, playwright for Python)
"""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TB = os.path.join(ROOT, "tb.mjs")
tmp = tempfile.mkdtemp()
repo = os.path.join(tmp, "repo")
site = os.path.join(tmp, "site")
procs = []

def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd or repo, check=True, capture_output=True, text=True).stdout

def tb(*args):
    return sh("node", TB, *args)

def show(i):
    return json.loads(tb("show", str(i), "--json"))

def check(cond, msg):
    if not cond:
        print("  FAIL -", msg); cleanup(); sys.exit(1)
    print("  ok -", msg)

def cleanup():
    for p in procs: p.terminate()

PAGE = {}
def wait_for(fn, timeout=8):
    # use the page's own wait so Playwright keeps handling routes/events meanwhile
    end = time.time() + timeout
    while time.time() < end:
        if fn(): return True
        PAGE["p"].wait_for_timeout(200) if PAGE else time.sleep(0.2)
    return False

# repo with a board
os.makedirs(repo)
sh("git", "init", "-q", "-b", "main"); sh("git", "config", "user.name", "T"); sh("git", "config", "user.email", "t@t")
sh("git", "commit", "-q", "--allow-empty", "-m", "init")
tb("init")
tb("add", "Existing task", "-p", "high", "--steps", "a; b")
tb("start", "1")
tb("issue", "1", "open question")

# site + mock api (ports must be free, or a stale server from an earlier run would answer)
import socket
for port in (5050, 5051):
    with socket.socket() as so:
        if so.connect_ex(("127.0.0.1", port)) == 0:
            print(f"port {port} is busy (stale test server?), stop it first"); sys.exit(1)
os.makedirs(site)
tb("pages", "--out", os.path.join(site, "index.html"))
procs.append(subprocess.Popen(["node", os.path.join(ROOT, "test", "mock-github.mjs"), repo, "5051"], stdout=subprocess.DEVNULL))
procs.append(subprocess.Popen([sys.executable, "-m", "http.server", "5050", "-d", site], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
time.sleep(1)
stats = lambda: json.load(urllib.request.urlopen("http://127.0.0.1:5051/_stats"))

INIT = "window.TB_API='http://127.0.0.1:5051';window.TB_RAW='http://127.0.0.1:5051/raw';"
URL = "http://127.0.0.1:5050/?repo=jannis/demo"

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 850})
    ctx.add_init_script(INIT)
    pg = ctx.new_page()
    PAGE["p"] = pg
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    print("read-only")
    pg.goto(URL)
    pg.wait_for_selector('.card[data-id="TB-1"]')
    check(pg.is_visible(".rochip"), "shows read-only badge without a token")
    check(not pg.is_visible("#newtask"), "new-task input hidden when read-only")
    pg.click('.card[data-id="TB-1"]')
    check(pg.is_disabled('[data-a=title]'), "drawer inputs disabled when read-only")
    pg.keyboard.press("Escape")

    print("settings + token")
    pg.click("#tbsetbtn")
    pg.fill("input[name=token]", "good-token")
    pg.click("#tbset button.primary")
    pg.wait_for_selector(".rochip", state="detached")
    check(pg.is_visible("#newtask"), "editing enabled after adding a token")

    print("web -> git")
    pg.fill("#newtask", "Made on the web")
    pg.press("#newtask", "Enter")
    check(wait_for(lambda: "Made on the web" in tb("list")), "add from web lands on the taskboard branch")
    check(show(2)["log"][0]["by"] == "jannis-web", "web edits are attributed to the GitHub login")
    pg.fill("[data-a=composer]", "note from web")
    pg.click("[data-a=post]")
    check(wait_for(lambda: any(e["msg"] == "note from web" for e in show(2)["log"])), "note from web saved")
    pg.keyboard.press("Escape")
    pg.drag_and_drop('.card[data-id="TB-2"]', '.col[data-status="review"]')
    check(wait_for(lambda: show(2)["status"] == "review"), "drag to Review moves the task")
    tree = sh("git", "ls-tree", "-r", "--name-only", "taskboard")
    check("board.json" in tree and "tasks/TB-2.json" in tree, "web commit keeps board.json and task files")
    check(json.loads(sh("git", "show", "taskboard:board.json"))["tasks"][1]["status"] == "review", "board.json in sync with task file")
    check(sh("git", "rev-parse", "taskboard^1") != "", "web commits are normal commits on the branch")

    print("git -> web")
    tb("log", "1", "progress from the CLI")
    check(wait_for(lambda: "progress from the CLI" in pg.inner_text(".card[data-id='TB-1']"), timeout=12), "CLI change appears on the page (polling)")

    print("concurrent writers")
    pg.click('.card[data-id="TB-1"]')
    pg.wait_for_selector("[data-a=composer]")
    # make the CLI write between the page's read and its ref update
    once = {"done": False}
    def sneak(route):
        if route.request.method == "POST" and not once["done"]:
            once["done"] = True
            tb("log", "1", "sneaky CLI write")
        route.continue_()
    pg.route("**/git/trees", sneak)
    before = stats()["conflicts"]
    pg.fill("[data-a=composer]", "web write during conflict")
    pg.click("[data-a=post]")
    check(wait_for(lambda: any(e["msg"] == "web write during conflict" for e in show(1)["log"])), "web write retried after a conflicting CLI write")
    msgs = [e["msg"] for e in show(1)["log"]]
    check("sneaky CLI write" in msgs, "the CLI write was not lost")
    check(stats()["conflicts"] > before, "the mock really rejected the first attempt (CAS)")
    pg.unroute("**/git/trees")

    print("steps / resolve / delete")
    pg.fill("[data-a=addstep]", "web step")
    pg.press("[data-a=addstep]", "Enter")
    check(wait_for(lambda: any(s["text"] == "web step" for s in show(1)["steps"])), "add step")
    pg.wait_for_selector("label.step:has-text('web step') input")
    pg.check("label.step:has-text('web step') input")
    check(wait_for(lambda: [s for s in show(1)["steps"] if s["text"] == "web step"][0]["done"]), "tick step")
    pg.on("dialog", lambda d: d.accept("answered on web") if d.type == "prompt" else d.accept())
    pg.click("[data-a=resolve]")
    check(wait_for(lambda: all(e.get("resolved") for e in show(1)["log"] if e["type"] == "issue")), "resolve issue")
    pg.click("[data-a=rm]")
    check(wait_for(lambda: "TB-1 " not in tb("list") and "TB-1\n" not in tb("list")), "delete task")
    check("TB-1.json" not in sh("git", "ls-tree", "-r", "--name-only", "taskboard"), "deleted task file removed from tree")

    print("old boards without board.json")
    # build a commit that has no board.json (like boards written by tb 0.1)
    tree = sh("git", "ls-tree", "taskboard").replace("\r", "")
    lines = [l for l in tree.splitlines() if not l.endswith("\tboard.json")]
    newtree = subprocess.run(["git", "mktree"], cwd=repo, input="\n".join(lines) + "\n", capture_output=True, text=True, check=True).stdout.strip()
    c = sh("git", "commit-tree", newtree, "-p", "taskboard", "-m", "legacy").strip()
    sh("git", "update-ref", "refs/heads/taskboard", c)
    pg.reload()
    pg.wait_for_selector('.card[data-id="TB-2"]')
    check(True, "loads a board without board.json (tree + file fallback)")
    pg.fill("#newtask", "after legacy")
    pg.press("#newtask", "Enter")
    check(wait_for(lambda: "after legacy" in tb("list")), "editing a legacy board works")
    check("board.json" in sh("git", "ls-tree", "--name-only", "taskboard"), "and writes board.json again")

    print("bad token")
    if pg.is_visible("[data-a=close]"): pg.click("[data-a=close]")
    pg.click("#tbsetbtn"); pg.fill("input[name=token]", "wrong"); pg.click("#tbset button.primary")
    check(wait_for(lambda: "401" in pg.inner_text("#toast")), "clear error for a rejected token")

    pg.screenshot(path=os.path.join(tmp, "pages.png"))
    check(not errors, f"no page errors {errors}")
    b.close()

cleanup()
print("screenshot:", os.path.join(tmp, "pages.png"))
print("all pages tests passed")
