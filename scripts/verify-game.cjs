/* Current game's mechanics checks: node scripts/verify-game.cjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "..", "block_crash.html"), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createGame() {
    const elements = new Map();
    const drawing = new Proxy({}, { get(target, name) { return target[name] || (() => {}); } });
    const makeElement = (id = "", tagName = "DIV") => ({
        id, tagName, width: 600, height: 400, value: "2", textContent: "", disabled: false, handlers: {},
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
        emit(name, event = {}) { for (const fn of this.handlers[name] || []) fn(event); },
        getContext() { return drawing; }, focus() {},
        getBoundingClientRect() { return { left: 20, top: 10, width: 300, height: 200 }; }
    });
    const document = Object.assign(makeElement("document"), {
        hidden: false,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id, id.endsWith("Button") ? "BUTTON" : id === "speedSelect" ? "SELECT" : id === "gameCanvas" ? "CANVAS" : "SPAN"));
            return elements.get(id);
        }
    });
    const window = makeElement("window");
    const context = vm.createContext({ document, window, requestAnimationFrame() {} });
    vm.runInContext(source, context, { filename: "block_crash.html" });
    const run = code => vm.runInContext(code, context);
    const snapshot = () => JSON.parse(run(`JSON.stringify({ score, lives, stage, started, paused, gameOver, cleared, leftPressed, rightPressed, speed, items, expandTime, remainingBricks, paddle, ball })`));
    return { run, snapshot, elements, document, window };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); process.exitCode = 1; }
}
function near(actual, expected, tolerance = 1e-7) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`); }

check("start, five speeds, UI locking and full restart", () => {
    for (let level = 1; level <= 5; level++) {
        const g = createGame();
        assert.equal(g.snapshot().started, false); assert.equal(g.snapshot().remainingBricks, 32);
        g.elements.get("speedSelect").value = String(level); g.run("startGame()");
        const s = g.snapshot(); assert.equal(s.started, true); assert.equal(s.speed, level + 2); near(Math.hypot(s.ball.dx, s.ball.dy), level + 2);
        assert.equal(g.elements.get("speedSelect").disabled, true); assert.equal(g.elements.get("startButton").disabled, true);
        g.elements.get("speedSelect").value = String(level % 5 + 1);
        g.elements.get("speedSelect").emit("change"); assert.deepEqual(g.snapshot(), s);
        g.elements.get("speedSelect").value = String(level);
        g.run("score = 10; lives = 1; stage = 2; paused = true; expandTime = 2; paddle.width = 150; items.push({ x: 20, y: 20, type: 'E' }); restartGame()");
        const reset = g.snapshot(); assert.equal(reset.score, 0); assert.equal(reset.lives, 3); assert.equal(reset.stage, 1); assert.equal(reset.paused, false);
        assert.equal(reset.expandTime, 0); assert.equal(reset.paddle.width, 100); assert.deepEqual(reset.items, []); assert.equal(reset.remainingBricks, 32);
    }
});

check("automatic 32/40/48 brick stages preserve score/lives; total clear is 120", () => {
    const g = createGame(); g.run("startGame(); lives = 4");
    for (const [targetStage, count] of [[1, 32], [2, 40], [3, 48]]) {
        assert.equal(g.snapshot().stage, targetStage); assert.equal(g.snapshot().remainingBricks, count);
        g.run("expandTime = 5; paddle.width = 150; items.push({ x: 0, y: 0, type: 'E' })");
        g.run(`while (stage === ${targetStage} && !gameOver) {
            const target = bricks.flat().find(brick => brick.visible);
            ball.x = target.x + 30; ball.y = target.y + 10;
            checkBrickCollision(ball.x, target.y - 20);
        }`);
        assert.equal(g.snapshot().lives, 4);
        assert.equal(g.snapshot().expandTime, 0); assert.equal(g.snapshot().paddle.width, 100); assert.deepEqual(g.snapshot().items, []);
        if (targetStage < 3) { assert.equal(g.snapshot().stage, targetStage + 1); assert.equal(g.snapshot().gameOver, false); }
    }
    const s = g.snapshot(); assert.equal(s.score, 120); assert.equal(s.gameOver, true); assert.equal(s.cleared, true); assert.equal(s.remainingBricks, 0);
    assert.equal(g.elements.get("pauseButton").disabled, true); assert.equal(g.elements.get("speedSelect").disabled, false);
});

check("one collision awards one point and removed brick cannot be hit twice", () => {
    const g = createGame(); g.run("startGame(); bricks.forEach(row => row.forEach(brick => brick.visible = false)); bricks[0][0].visible = true; remainingBricks = 2; ball.x = 55; ball.y = 66; ball.dx = 2; ball.dy = -3; checkBrickCollision(55, 70)");
    assert.equal(g.snapshot().score, 1); assert.equal(g.snapshot().remainingBricks, 1); assert.equal(g.run("bricks[0][0].visible"), false);
    g.run("checkBrickCollision(ball.x, ball.y)"); assert.equal(g.snapshot().score, 1); assert.equal(g.snapshot().remainingBricks, 1);
});

check("maximum speed reflects from each brick face without tunneling", () => {
    const cases = [
        { x: 55, y: 71, dx: 0, dy: -7, axis: "dy", sign: 1 },
        { x: 55, y: 29, dx: 0, dy: 7, axis: "dy", sign: -1 },
        { x: 14, y: 50, dx: 7, dy: 0, axis: "dx", sign: -1 },
        { x: 96, y: 50, dx: -7, dy: 0, axis: "dx", sign: 1 }
    ];
    for (const item of cases) {
        const g = createGame(); g.elements.get("speedSelect").value = "5";
        g.run(`startGame(); bricks.forEach(row => row.forEach(brick => brick.visible = false)); bricks[0][0].visible = true; remainingBricks = 2; Object.assign(ball, ${JSON.stringify({ x: item.x, y: item.y, dx: item.dx, dy: item.dy })}); moveBall()`);
        assert.equal(g.snapshot().score, 1); assert.equal(Math.sign(g.snapshot().ball[item.axis]), item.sign);
    }
});

check("wall and descending paddle catches; ascending ball is not reflected", () => {
    const g = createGame(); g.run("startGame(); bricks.forEach(row => row.forEach(brick => brick.visible = false)); Object.assign(ball, { x: 590, y: 200, dx: 7, dy: 0 }); moveBall()");
    let b = g.snapshot().ball; assert.ok(b.dx < 0); assert.ok(b.x >= 8 && b.x <= 592);
    g.run("Object.assign(ball, { x: 300, y: 359, dx: 0, dy: 7 }); moveBall()"); assert.ok(g.snapshot().ball.dy < 0); assert.equal(g.snapshot().lives, 3);
    g.run("Object.assign(ball, { x: paddle.x - 6, y: 359, dx: 0, dy: 7 }); moveBall()"); assert.ok(g.snapshot().ball.dy < 0);
    g.run("Object.assign(ball, { x: 300, y: 364, dx: 0, dy: -7 }); moveBall()"); assert.equal(g.snapshot().ball.dy, -7);
});

check("life loss preserves score/bricks, resets items/effect/input, then game over", () => {
    const g = createGame();
    g.run("startGame(); score = 9; remainingBricks = 23; expandTime = 5; paddle.width = 150; items.push({ x: 0, y: 0, type: 'E' }); leftPressed = true; rightPressed = true; Object.assign(ball, { x: 20, y: 412, dx: 0, dy: 7 }); moveBall()");
    let s = g.snapshot(); assert.equal(s.lives, 2); assert.equal(s.gameOver, false); assert.equal(s.score, 9); assert.equal(s.remainingBricks, 23);
    assert.equal(s.expandTime, 0); assert.equal(s.paddle.width, 100); assert.deepEqual(s.items, []); assert.equal(s.leftPressed, false); assert.equal(s.rightPressed, false); assert.equal(s.ball.y, 350);
    g.run("lives = 1; Object.assign(ball, { x: 20, y: 412, dx: 0, dy: 7 }); moveBall()");
    s = g.snapshot(); assert.equal(s.lives, 0); assert.equal(s.gameOver, true); assert.equal(s.cleared, false);
    g.run("startGame()"); assert.equal(g.snapshot().lives, 3); assert.equal(g.snapshot().score, 0);
});

check("pause freezes motion/effects and resume clears held arrows", () => {
    const g = createGame();
    g.run("startGame(); expandTime = 5; paddle.width = 150; items.push({ x: 20, y: 50, type: 'L' }); leftPressed = true; togglePause(); gameLoop(0)");
    const before = g.snapshot(); g.run("gameLoop(1000); gameLoop(2000)"); assert.deepEqual(g.snapshot(), before);
    assert.equal(g.elements.get("speedSelect").disabled, true);
    g.run("leftPressed = true; rightPressed = true; startGame()"); assert.equal(g.snapshot().paused, false); assert.equal(g.snapshot().leftPressed, false); assert.equal(g.snapshot().rightPressed, false);
});

check("resume after suspended animation frames does not jump forward", () => {
    const g = createGame(); g.run("startGame(); expandTime = 5; gameLoop(0); togglePause()");
    const paused = g.snapshot(); g.run("togglePause(); gameLoop(6000)");
    const resumed = g.snapshot(); near(resumed.ball.x, paused.ball.x); near(resumed.ball.y, paused.ball.y); near(resumed.expandTime, paused.expandTime);
});

check("E refreshes to 8 seconds without stacking; expiry restores width; L caps at 5", () => {
    const g = createGame(); g.run("startGame(); paddle.x = 490; items = [{ x: 520, y: 360, type: 'E' }]; moveItems()");
    let s = g.snapshot(); assert.equal(s.paddle.width, 150); assert.equal(s.paddle.x, 450); assert.equal(s.expandTime, 8); assert.deepEqual(s.items, []);
    g.run("expandTime = 1; items = [{ x: 520, y: 360, type: 'E' }]; moveItems()");
    assert.equal(g.snapshot().paddle.width, 150); assert.equal(g.snapshot().expandTime, 8);
    g.run("expandTime = .01; gameLoop(0); gameLoop(20)"); assert.equal(g.snapshot().paddle.width, 100); assert.equal(g.snapshot().expandTime, 0);
    g.run("lives = 4; items = [{ x: paddle.x - 5, y: 360, type: 'L' }]; moveItems(); items = [{ x: paddle.x + 20, y: 360, type: 'L' }]; moveItems()"); assert.equal(g.snapshot().lives, 5);
    g.run("items = [{ x: 20, y: 410, type: 'E' }]; moveItems()"); assert.deepEqual(g.snapshot().items, []);
});

check("fixed 60Hz accumulator gives equal progress on 60/120Hz displays", () => {
    const games = [createGame(), createGame()];
    games.forEach(g => g.run("startGame(); Object.assign(ball, { x: 200, y: 250, dx: 2.4, dy: 0 }); gameLoop(0)"));
    for (let index = 0; index < games.length; index++) {
        const rate = index === 0 ? 60 : 120;
        for (let frame = 1; frame <= rate; frame++) games[index].run(`gameLoop(${frame * 1000 / rate})`);
    }
    const a = games[0].snapshot(); const b = games[1].snapshot(); near(a.ball.x, b.ball.x); near(a.ball.y, b.ball.y);
    assert.ok(Math.abs(a.ball.x - (200 + 60 * 2.4)) <= 2.400001, "one second advances about 60 ticks");
});

check("keyboard/repeat/native controls, blur and hidden-page auto pause", () => {
    const g = createGame(); let prevented = 0;
    const key = (code, repeat = false, tagName = "BODY") => ({ code, repeat, target: { tagName }, preventDefault() { prevented++; } });
    g.document.emit("keydown", key("Space")); assert.equal(g.snapshot().started, true);
    g.document.emit("keydown", key("KeyP")); assert.equal(g.snapshot().paused, true);
    g.document.emit("keydown", key("KeyP", true)); assert.equal(g.snapshot().paused, true);
    g.document.emit("keydown", key("Space")); assert.equal(g.snapshot().paused, false);
    g.document.emit("keydown", key("ArrowLeft")); g.run("movePaddle()"); assert.equal(g.snapshot().paddle.x, 243);
    g.document.emit("keyup", key("ArrowLeft")); assert.equal(g.snapshot().leftPressed, false);
    const previousPrevented = prevented;
    g.document.emit("keydown", key("Space", false, "BUTTON")); g.document.emit("keydown", key("ArrowLeft", false, "SELECT")); g.document.emit("keydown", key("KeyR", false, "INPUT"));
    assert.equal(prevented, previousPrevented); assert.equal(g.snapshot().leftPressed, false);
    g.run("leftPressed = true; rightPressed = true"); g.window.emit("blur"); assert.equal(g.snapshot().paused, true); assert.equal(g.snapshot().leftPressed, false); assert.equal(g.snapshot().rightPressed, false);
    g.run("togglePause(); leftPressed = true"); g.document.hidden = true; g.document.emit("visibilitychange"); assert.equal(g.snapshot().paused, true); assert.equal(g.snapshot().leftPressed, false);
    g.document.hidden = false; g.document.emit("visibilitychange"); assert.equal(g.snapshot().paused, true);
});

check("scaled mouse positioning and paddle clamps work only during active play", () => {
    const g = createGame(); const canvas = g.elements.get("gameCanvas");
    canvas.emit("mousemove", { clientX: 95 }); assert.equal(g.snapshot().paddle.x, 250);
    g.run("startGame()"); canvas.emit("mousemove", { clientX: 95 }); near(g.snapshot().paddle.x, 100);
    canvas.emit("mousemove", { clientX: -100 }); assert.equal(g.snapshot().paddle.x, 0);
    canvas.emit("mousemove", { clientX: 1000 }); assert.equal(g.snapshot().paddle.x, 500);
    g.run("togglePause()"); canvas.emit("mousemove", { clientX: 95 }); assert.equal(g.snapshot().paddle.x, 500);
    g.run("togglePause(); leftPressed = true; paddle.x = 2; movePaddle()"); assert.equal(g.snapshot().paddle.x, 0);
    g.run("leftPressed = false; rightPressed = true; paddle.width = 150; paddle.x = 449; movePaddle()"); assert.equal(g.snapshot().paddle.x, 450);
});

console.log(`${passed} passed, ${failed} failed (${passed + failed} current-game mechanics checks).`);
