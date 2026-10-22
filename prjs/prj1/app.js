import { loadShadersFromURLS, buildProgramFromSources, setupWebGL } from "../../libs/utils.js";
import { vec2, vec3, flatten } from "../../libs/MV.js";
import { GUI } from "../../libs/dat.gui.module.js";

/** @type {HTMLCanvasElement} */
let canvas;
/** @type {WebGL2RenderingContext} */
let gl;

let program;            // search technique: the quad and its fragment shader
let surface_program;    // surfaces technique: one surface per site
let site_program;       // site markers, drawn as gl.POINTS
let quad_vao;           // the quad covering the whole viewport
let sites_vao;          // empty: sites and surfaces read no attributes

// We fetch the uniform locations of each program once, in setup(), and keep
// them here, the same way ex16 keeps u_center, u_scale and
// u_world_half_width in global variables instead of asking for them every
// frame.
let quad_u, surface_u, site_u;

// The maximum number of sites. We write it here and once in each shader that
// reads the site arrays, and nowhere else, as the project statement asks.
const MAX_SITES = 32;

// We keep the world coordinate system of ex14-ex16 unchanged: WORLD_HALF_WIDTH
// is how much of the world is visible from the centre to the right edge of
// the canvas when the view is neither panned nor zoomed.
const WORLD_HALF_WIDTH = 10.0;
let center = [0.0, 0.0];
let scale = 1.0;

// Each site is { position: vec2, color: vec3, velocity: vec2 }, with the
// position in world coordinates, so that panning and zooming never touch
// it, and the velocity in world units per second, used only while the sites
// are animated.
const sites = [];

let metric = 0;     // 0 Euclidean, 1 Manhattan, 2 Chebyshev, 3 Minkowski
let borders = true;

// The values the options panel in the top-right corner edits (see
// setup_gui()). dat.gui, from the course libraries, changes them in place.
//
// - p is the exponent of the Minkowski metric, (|dx|^p + |dy|^p)^(1/p), the
//   first of the "Possible Challenges" of the project statement: moving it
//   from 1 (Manhattan) through 2 (Euclidean) towards large values
//   (Chebyshev) morphs the cells between the three shapes of keys 1-3.
// - shading is how much each cell darkens away from its site, from 0 (not
//   at all) to 1.
// - animate makes the sites drift, the second of the "Possible Challenges":
//   it shows that the diagram, and the agreement between both techniques,
//   hold up under continuous motion and not only in still frames.
const options = {
    p: 2.0,
    shading: 0.5,
    animate: false,
};

// The controllers of p and animate in the options panel, kept so that the
// keys that change those values (1-3 and 'a') can update the panel too.
let p_controller, animate_controller;

// How fast the sites drift while animated, in world units per second.
const SITE_SPEED = 2.0;

// How many pixels the cell borders reach on each side of a boundary.
const BORDER_WIDTH = 1.5;

// Mouse state. We use the same down / last / moved variables as setup_mouse()
// in ex16, and add dragged_site, the index of the site being dragged, or -1
// when the drag pans the view instead.
let down = null, last = null, moved = false;
let dragged_site = -1;
let mouse = [0, 0];     // last pointer position, needed by the 'x' key

// How close to a site, in pixels, a mousedown must fall to grab it. We
// measure it in pixels and not in world units so that grabbing a site feels
// the same at every zoom level.
const PICK_RADIUS = 10;

// How many vertices go around the rim of the Euclidean cone. The project
// statement says 64 or 128 sides are plenty for smooth cell boundaries. We
// compared both techniques pixel by pixel with 64, 128 and 256 sides: going
// from 64 to 128 halved the pixels where they disagree (and quartered them
// when zoomed out), while 256 gained little more, so we use 128.
// Manhattan and Chebyshev always need exactly 4; the Minkowski surface uses
// as many as the cone.
const CONE_SIDES = 128;

// The tie-break step between consecutive sites, as a fraction of the height
// R of the surfaces (see u_tie_bias in surface.vert). It is a fraction of R
// because the depth buffer stores height / R: one step has to stay well
// above the precision of the depth buffer, and yet far below one pixel, so
// that it only ever decides real ties.
const TIE_BIAS = 1.0e-5;

// What the 'm' key cycles through: the search technique alone, the surfaces
// technique alone, and a split view with the surfaces on the left half of
// the canvas and the search on the right half, to check that both agree.
const SEARCH = 0, SURFACES = 1, SPLIT = 2;
let technique = SEARCH;


// ---------------------------------------------------------------------------
// World coordinates. We implement them as in ex16, with one addition: the
// canvas now fills the browser window and is rarely square, so we correct
// for its aspect ratio - otherwise circles would not stay circles.
// ---------------------------------------------------------------------------

function aspect() {
    return canvas.width / canvas.height;
}

// Converts a position in canvas pixels to world coordinates. The x axis is
// exactly as in ex16; the y axis divides by the aspect ratio, because the
// visible half height of the world is the half width over the aspect ratio.
function to_world(x, y) {
    const nx = (x / canvas.width) * 2 - 1;
    const ny = 1 - (y / canvas.height) * 2;
    return vec2(
        nx * WORLD_HALF_WIDTH * scale + center[0],
        ny * WORLD_HALF_WIDTH * scale / aspect() + center[1]
    );
}

// Returns how many world units one pixel of the screen is worth. It is the
// same along x and y, precisely because we correct for the aspect ratio.
function world_units_per_pixel() {
    return (2 * WORLD_HALF_WIDTH * scale) / canvas.width;
}

// Moves the view by (dx, dy) pixels, as in ex16. Only center changes: the
// positions stored for the sites stay untouched.
function pan(dx, dy) {
    const world_units = world_units_per_pixel();
    center[0] -= dx * world_units;
    center[1] += dy * world_units;
}


// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

// Picks a random colour, as in ex13-ex16.
function random_color() {
    return vec3(Math.random(), Math.random(), Math.random());
}

// Adds a site at the given canvas position, unless MAX_SITES is already
// reached - the same choice ex16 makes when its buffers are full.
function add_site(x, y) {
    if (sites.length >= MAX_SITES) return;
    sites.push({ position: to_world(x, y), color: random_color(), velocity: random_velocity() });
}

// Picks a velocity of SITE_SPEED in a random direction.
function random_velocity() {
    const angle = Math.random() * 2 * Math.PI;
    return vec2(SITE_SPEED * Math.cos(angle), SITE_SPEED * Math.sin(angle));
}

// Moves every site along its velocity for dt seconds, and makes it bounce
// off the edges of the visible part of the world, so that the sites never
// drift out of sight. The site being dragged stays under the pointer.
function move_sites(dt) {
    const half_width = WORLD_HALF_WIDTH * scale;
    const half_size = [half_width, half_width / aspect()];
    sites.forEach((s, i) => {
        if (i == dragged_site) return;
        for (let k = 0; k < 2; k++) {
            s.position[k] += s.velocity[k] * dt;
            // only turn back when moving outwards, so that a site left
            // outside the view by a pan or a zoom comes back into it
            if (s.position[k] < center[k] - half_size[k] && s.velocity[k] < 0 ||
                s.position[k] > center[k] + half_size[k] && s.velocity[k] > 0)
                s.velocity[k] = -s.velocity[k];
        }
    });
}

// Returns the index of the site nearest to p (in world coordinates), or -1
// if no site is closer than max_dist. We always measure this with the
// Euclidean distance, whatever the current metric, since it only decides
// which site the user is pointing at.
function nearest_site(p, max_dist = Infinity) {
    let nearest = -1;
    for (let i = 0; i < sites.length; i++) {
        const d = Math.hypot(p[0] - sites[i].position[0], p[1] - sites[i].position[1]);
        if (d < max_dist) {
            max_dist = d;
            nearest = i;
        }
    }
    return nearest;
}


// ---------------------------------------------------------------------------
// Input. The event listeners are already set up in setup_input(); fill in
// these functions. Mouse positions are in canvas pixels, with (0, 0) at the
// top-left corner and y growing downwards.
// ---------------------------------------------------------------------------

// Remembers where the button went down and checks whether it went down on a
// site. Nothing is decided yet: we only know on the next move, or on mouseup,
// whether this is a click, a site being dragged, or a pan.
function on_mouse_down(x, y) {
    down = [x, y];
    last = down;
    moved = false;
    dragged_site = nearest_site(to_world(x, y), PICK_RADIUS * world_units_per_pixel());
}

// Ignores the first 4 pixels of movement, as in ex16, and only then commits
// to a drag: it moves the grabbed site to the pointer, or pans the view if
// no site was grabbed. Since last starts out equal to down, the first pan
// covers the whole distance from the mousedown, and no pixel is lost.
function on_mouse_move(x, y) {
    mouse = [x, y];
    if (down === null) return;
    const here = [x, y];
    if (!moved && Math.hypot(here[0] - down[0], here[1] - down[1]) <= 4) return;
    moved = true;
    if (dragged_site >= 0)
        sites[dragged_site].position = to_world(x, y);
    else
        pan(here[0] - last[0], here[1] - last[1]);
    last = here;
}

// Adds a site only if the mouse never moved and the click did not land on an
// existing site; otherwise it just ends the drag. We check down because the
// listener is on the window, and a mouseup may arrive without a mousedown on
// the canvas.
function on_mouse_up(x, y) {
    if (down === null) return;
    if (!moved && dragged_site < 0) add_site(x, y);
    down = null;
    dragged_site = -1;
}

// dy > 0 when the wheel is scrolled down (towards the user)
// Zooms about the centre of the canvas, with the same formula and limits as
// in ex15 and ex16.
function on_wheel(x, y, dy) {
    scale = Math.min(4.0, Math.max(0.2, scale * (1 + dy / 1000)));
}

function on_key(key) {
    switch (key) {
        case '1':       // Euclidean distance
            metric = 0;
            show_p(2.0);
            break;
        case '2':       // Manhattan distance
            metric = 1;
            show_p(1.0);
            break;
        case '3':       // Chebyshev distance
            metric = 2;
            show_p(10.0);   // Chebyshev is p = infinity: the slider's maximum
            break;
        case 'b':       // toggle cell borders
            borders = !borders;
            break;
        case 'x': {     // remove the site under the pointer
            const i = nearest_site(to_world(mouse[0], mouse[1]));
            if (i >= 0) sites.splice(i, 1);
            // Removing a site shifts the index of every site after it, so a
            // drag in progress could end up moving the wrong site, or one
            // that no longer exists. We simply end any drag here.
            down = null;
            dragged_site = -1;
            break;
        }
        case 'm':       // switch rendering technique / split view
            technique = (technique + 1) % 3;
            break;
        case 'a':       // ours: start or stop animating the sites
            options.animate = !options.animate;
            animate_controller.updateDisplay();
            break;
    }
}


// ---------------------------------------------------------------------------

function resize() {
    // Match the canvas's drawing buffer to the size it is shown at, and
    // draw over all of it
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}

function setup_input() {
    canvas.addEventListener("mousedown", (event) => on_mouse_down(event.offsetX, event.offsetY));
    canvas.addEventListener("mousemove", (event) => on_mouse_move(event.offsetX, event.offsetY));
    window.addEventListener("mouseup", (event) => on_mouse_up(event.offsetX, event.offsetY));
    canvas.addEventListener("wheel", (event) => {
        on_wheel(event.offsetX, event.offsetY, event.deltaY);
        event.preventDefault();     // don't let the page scroll as well
    });
    // We ignore the keys typed into a box of the options panel, as the hint
    // of prob14 in lab 5 advises: otherwise typing 2 into the value of p
    // would also switch to the Manhattan metric.
    window.addEventListener("keydown", (event) => {
        if (event.target.tagName != "INPUT") on_key(event.key);
    });
}

// Builds the options panel with dat.gui, which the course libraries
// include: it places itself in the top-right corner, and every controller
// edits one field of options directly. Moving p switches to the Minkowski
// metric, since that is the only one it affects; keys 1-3 switch back.
//
// We ask dat.gui to put the button that hides and shows the panel at the
// top (closeOnTop) instead of at the bottom: there it is part of the panel,
// rather than drawn on its own below it, and it doubles as the panel's
// title. GUI.TEXT_CLOSED is the text dat.gui shows while the panel is open
// (clicking it closes the panel), and GUI.TEXT_OPEN the text while it is
// closed.
function setup_gui() {
    GUI.TEXT_CLOSED = "▾ Options";
    GUI.TEXT_OPEN = "▸ Options";
    const gui = new GUI({ closeOnTop: true });
    p_controller = gui.add(options, "p", 1.0, 10.0, 0.01).name("Minkowski p").onChange(() => metric = 3);
    gui.add(options, "shading", 0.0, 1.0, 0.01).name("shading");
    animate_controller = gui.add(options, "animate").name("animate (a)");
    // dat.gui turns a function into a button that calls it
    gui.add({ benchmark }, "benchmark").name("run benchmark");
}

// Moves the p of the options panel to the value that matches the metric
// just selected by key 1, 2 or 3, so that the panel never shows a p that is
// not the one in use. updateDisplay() only redraws the controller: unlike
// dragging the slider, it does not call onChange(), so the metric selected
// by the key stays as it is.
function show_p(p) {
    options.p = p;
    p_controller.updateDisplay();
}

function setup(shaders) {
    canvas = document.getElementById("gl-canvas");
    // We ask for a context without antialiasing. With it, WebGL blends the
    // colours of the pixels along the edges of every triangle, and in the
    // surfaces technique the cell boundaries are exactly such edges, while
    // in the search technique they are not: the two would then differ along
    // every boundary, instead of agreeing on every pixel.
    gl = setupWebGL(canvas, { antialias: false });

    program = buildProgramFromSources(gl, shaders["quad.vert"], shaders["quad.frag"]);
    surface_program = buildProgramFromSources(gl, shaders["surface.vert"], shaders["surface.frag"]);
    site_program = buildProgramFromSources(gl, shaders["site.vert"], shaders["site.frag"]);

    quad_u = get_uniforms(program);
    surface_u = get_uniforms(surface_program);
    site_u = get_uniforms(site_program);

    // A quad covering the whole viewport, as two triangles: its corners are
    // the corners of clip space, from (-1, -1) to (1, 1)
    const corners = new Float32Array([
        -1, -1,     1, -1,     1, 1,       // first triangle
        -1, -1,     1, 1,     -1, 1,       // second triangle
    ]);

    quad_vao = gl.createVertexArray();
    gl.bindVertexArray(quad_vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    const a_position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // The sites need no buffer at all, but WebGL2 still expects a vertex
    // array object to be bound when drawing, so we give them an empty one.
    sites_vao = gl.createVertexArray();

    resize();
    window.addEventListener("resize", resize);
    setup_input();
    setup_gui();

    // A click on the benchmark results hides them.
    const result = document.getElementById("benchmark");
    result.addEventListener("click", () => result.style.display = "none");

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    window.requestAnimationFrame(animate);
}

// Fetches the locations of the uniforms that describe the view and the
// sites. All three programs declare them with the same names, so we fetch
// them the same way; a program that does not use one of them simply gets
// null for it, and WebGL ignores any value set on a null location.
function get_uniforms(program) {
    return {
        center: gl.getUniformLocation(program, "u_center"),
        scale: gl.getUniformLocation(program, "u_scale"),
        world_half_width: gl.getUniformLocation(program, "u_world_half_width"),
        aspect: gl.getUniformLocation(program, "u_aspect"),
        site_position: gl.getUniformLocation(program, "u_site_position"),
        site_color: gl.getUniformLocation(program, "u_site_color"),
        n_sites: gl.getUniformLocation(program, "u_n_sites"),
        metric: gl.getUniformLocation(program, "u_metric"),
        p: gl.getUniformLocation(program, "u_p"),
        borders: gl.getUniformLocation(program, "u_borders"),
        border_width: gl.getUniformLocation(program, "u_border_width"),
        shading: gl.getUniformLocation(program, "u_shading"),
        rim_vertices: gl.getUniformLocation(program, "u_rim_vertices"),
        height: gl.getUniformLocation(program, "u_height"),
        tie_bias: gl.getUniformLocation(program, "u_tie_bias"),
        pass: gl.getUniformLocation(program, "u_pass"),
        hybrid: gl.getUniformLocation(program, "u_hybrid"),
        first_index: gl.getUniformLocation(program, "u_first_index"),
        second_index: gl.getUniformLocation(program, "u_second_index"),
    };
}

// Sends the view, the sites, the metric, the options of the panel and the
// height of the surfaces to the program currently in use, whose locations
// are u.
// flatten() only fills the first sites.length entries of each uniform array;
// the rest are never read, because u_n_sites (and the number of points or
// instances drawn) stops every shader at sites.length.
function set_uniforms(u) {
    gl.uniform2fv(u.center, center);
    gl.uniform1f(u.scale, scale);
    gl.uniform1f(u.world_half_width, WORLD_HALF_WIDTH);
    gl.uniform1f(u.aspect, aspect());
    gl.uniform2fv(u.site_position, flatten(sites.map(s => s.position)));
    gl.uniform3fv(u.site_color, flatten(sites.map(s => s.color)));
    gl.uniform1i(u.n_sites, sites.length);
    gl.uniform1i(u.metric, metric);
    gl.uniform1f(u.p, options.p);
    gl.uniform1i(u.borders, borders ? 1 : 0);   // a bool uniform is set as an int
    gl.uniform1f(u.border_width, BORDER_WIDTH);
    gl.uniform1f(u.shading, options.shading);

    // Both techniques get the same height and tie-break, so that in the
    // split view they break ties exactly the same way.
    const height = surface_height();
    gl.uniform1f(u.height, height);
    gl.uniform1f(u.tie_bias, TIE_BIAS * height);
}

// The names shown in the status label, indexed by technique and by metric.
const TECHNIQUE_NAMES = ["Search", "Surfaces", "Split (surfaces | search)"];
const METRIC_NAMES = ["Euclidean", "Manhattan", "Chebyshev", "Minkowski"];

// Writes the current technique, metric, border setting and number of sites
// into the status label. With the borders off, both techniques draw the
// same picture by design, so without this label there is no way to tell
// which one is on the screen. We only touch the page when the text actually
// changes, since this runs every frame.
function update_status() {
    const text = TECHNIQUE_NAMES[technique] + " · " + METRIC_NAMES[metric] +
        (metric == 3 ? " p=" + options.p.toFixed(2) : "") +
        " · borders " + (borders ? "on" : "off") +
        " · " + sites.length + "/" + MAX_SITES + " sites" +
        (options.animate ? " · animated" : "");
    const status = document.getElementById("status");
    if (status.textContent != text)
        status.textContent = text;
}

// Draws the diagram with the search technique: the quad covers the whole
// canvas, and its fragment shader does all the work. With no sites there is
// no diagram to draw, and the canvas keeps the clear colour.
function draw_search() {
    if (sites.length == 0) return;

    gl.useProgram(program);
    set_uniforms(quad_u);
    gl.uniform1i(quad_u.hybrid, 0);     // search every site, see quad.frag

    gl.bindVertexArray(quad_vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
}

// Returns the height R of the rim of every surface. It has to be large
// enough for every surface to cover the whole visible canvas, however far
// its site is from the view: we take, over all the sites, the Manhattan
// distance from the site to the farthest corner of the canvas, which is
// never smaller than the Euclidean or Chebyshev one, and double it, so that
// the polygonal cone, slightly smaller than its circle, covers it as well.
// The rim then always stays outside the canvas.
function surface_height() {
    const half_width = WORLD_HALF_WIDTH * scale;
    const half_height = half_width / aspect();
    let r = 0;
    for (const s of sites) {
        r = Math.max(r,
            Math.abs(s.position[0] - center[0]) + half_width +
            Math.abs(s.position[1] - center[1]) + half_height);
    }
    return 2 * r;
}

// Draws every surface once: one fan per site, all of them in a single
// gl.drawArraysInstanced() call with as many instances as there are sites,
// as the project statement describes. The depth test does the rest, so we
// enable it only for this draw call, and disable it again so that the site
// markers drawn afterwards do not take part in it. pass tells surface.frag
// what to write: the shaded colour (0), or which site the surface belongs
// to, either the nearest one (1) or the second nearest (2).
function draw_surface_pass(pass) {
    const rim_vertices = (metric == 1 || metric == 2) ? 4 : CONE_SIDES;

    gl.useProgram(surface_program);
    set_uniforms(surface_u);
    gl.uniform1i(surface_u.rim_vertices, rim_vertices);
    gl.uniform1i(surface_u.pass, pass);
    gl.uniform1i(surface_u.first_index, 0);     // texture unit 0

    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(sites_vao);
    // the apex, the rim vertices, and the first rim vertex again
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, rim_vertices + 2, sites.length);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
}

// Draws the diagram with the surfaces technique. Without borders, one pass
// is all it takes. With borders we need, at every pixel, not only the
// nearest site but also the second nearest, which the depth test does not
// give us for free - the project statement mentions a hybrid approach for
// this among its extras, and this is ours, in three steps:
//
// 1. We draw the surfaces into a texture of our own (the "first" target),
//    writing at every pixel the index of the site whose surface is lowest
//    there: the nearest site, exactly as the depth test always finds it.
// 2. We draw them again into a second texture, but now every surface
//    discards its fragments at the pixels where it was the nearest one. With
//    the lowest surface "peeled off", the depth test finds the next one
//    down: the second nearest site. This is known as depth peeling.
// 3. quad.frag reads both indices, and only measures the distance to those
//    two sites to shade the colour and draw the borders, with exactly the
//    same code as the search technique - but without searching, since the
//    depth test has already told it which two sites to look at.
function draw_surfaces() {
    if (sites.length == 0) return;

    if (!borders) {
        draw_surface_pass(0);
        return;
    }

    update_targets();

    // 1. the nearest site; index 0 wherever nothing is drawn
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.first.framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    draw_surface_pass(1);

    // 2. the second nearest site; index 255, meaning "none", wherever only
    // one surface covers the pixel
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.second.framebuffer);
    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.first.texture);
    draw_surface_pass(2);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    // 3. the picture itself, on the canvas
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.second.texture);

    gl.useProgram(program);
    set_uniforms(quad_u);
    gl.uniform1i(quad_u.hybrid, 1);
    gl.uniform1i(quad_u.first_index, 0);        // texture unit 0
    gl.uniform1i(quad_u.second_index, 1);       // texture unit 1

    gl.bindVertexArray(quad_vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
}

// ---------------------------------------------------------------------------
// Performance comparison, the third of the "Possible Challenges". We measure
// how long each technique takes to draw one frame as the number of sites
// grows, with the borders off, so that each technique does only its own
// work. Frames are normally paced by the screen's refresh rate, which would
// hide the difference, so we draw them back to back instead, as fast as the
// GPU allows: a draw call only queues work for the GPU, so before reading
// the clock we wait for that work to finish, with gl.readPixels(), which
// cannot return before the pixel it reads has been drawn.
// ---------------------------------------------------------------------------

const BENCHMARK_SITES = [1, 2, 4, 8, 16, 32];
const BENCHMARK_FRAMES = 30;

// Waits until the GPU has finished everything queued so far.
function wait_for_gpu() {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

// Returns how many milliseconds draw() takes per frame, on average.
function time_frames(draw) {
    draw();                     // the first frame may include setting up
    wait_for_gpu();
    const start = performance.now();
    for (let i = 0; i < BENCHMARK_FRAMES; i++) {
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        draw();
    }
    wait_for_gpu();
    return (performance.now() - start) / BENCHMARK_FRAMES;
}

// Times both techniques with random sites spread over the visible canvas,
// for each number of sites in BENCHMARK_SITES, under the current metric;
// then shows the results in a table at the bottom-left corner of the page,
// and in the console, and puts the user's own sites back.
function benchmark() {
    const own_sites = sites.splice(0);
    const own_borders = borders;
    borders = false;

    const half_width = WORLD_HALF_WIDTH * scale;
    const half_height = half_width / aspect();
    const rows = [];
    for (const n of BENCHMARK_SITES) {
        sites.length = 0;
        for (let i = 0; i < n; i++) {
            sites.push({
                position: vec2(center[0] + (Math.random() * 2 - 1) * half_width,
                               center[1] + (Math.random() * 2 - 1) * half_height),
                color: random_color(),
                velocity: random_velocity(),
            });
        }
        rows.push({ sites: n, search: time_frames(draw_search), surfaces: time_frames(draw_surfaces) });
    }

    sites.splice(0, sites.length, ...own_sites);
    borders = own_borders;

    console.table(rows);
    const lines = rows.map(r =>
        String(r.sites).padStart(5) + r.search.toFixed(2).padStart(10) + r.surfaces.toFixed(2).padStart(10));
    const result = document.getElementById("benchmark");
    result.textContent =
        "ms per frame, " + METRIC_NAMES[metric] + ", " + canvas.width + "x" + canvas.height + "\n" +
        "sites    search  surfaces\n" + lines.join("\n");
    result.style.display = "block";
}

// The two textures the hybrid borders draw into, with the depth buffer they
// share, all the size of the canvas. We create them the first time they are
// needed, and again whenever the canvas has changed size since.
let targets = null;

function update_targets() {
    if (targets && targets.width == canvas.width && targets.height == canvas.height)
        return;

    if (targets) {
        for (const t of [targets.first, targets.second]) {
            gl.deleteFramebuffer(t.framebuffer);
            gl.deleteTexture(t.texture);
        }
        gl.deleteRenderbuffer(targets.depth);
    }

    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, canvas.width, canvas.height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    targets = {
        width: canvas.width,
        height: canvas.height,
        depth,
        first: create_target(depth),
        second: create_target(depth),
    };
}

// Creates a framebuffer that draws into a new texture of the size of the
// canvas, using the given depth buffer. Each texel holds a site index, which
// we store in the red channel as index / 255: an 8-bit channel holds every
// index up to MAX_SITES exactly. The texture is only ever read one texel per
// pixel, with texelFetch(), so it needs no filtering at all.
function create_target(depth) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { framebuffer, texture };
}

// Draws one point per site. We follow the answer to Q3 of the project
// statement: the positions and colours are already uniforms, so each vertex
// only needs gl_VertexID to know which site it is, and no buffer is needed.
function draw_sites() {
    if (sites.length == 0) return;

    gl.useProgram(site_program);
    set_uniforms(site_u);

    // site.frag fades the edge of each marker out through its alpha, so we
    // blend the markers with the diagram underneath, and only them.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(sites_vao);
    gl.drawArrays(gl.POINTS, 0, sites.length);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
}

// The timestamp of the previous frame, in milliseconds, to know how much
// time has passed when the sites are animated.
let last_timestamp = null;

function animate(timestamp) {
    window.requestAnimationFrame(animate);

    // We move the sites by the time actually elapsed, so that they drift at
    // the same speed whatever the frame rate; after a long pause (a hidden
    // tab, say) we move them by at most a tenth of a second.
    if (options.animate && last_timestamp !== null)
        move_sites(Math.min((timestamp - last_timestamp) / 1000, 0.1));
    last_timestamp = timestamp;

    // The depth buffer must be cleared every frame as well, as in ex17-ex20,
    // or the surfaces of this frame would be compared against the last one.
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (technique == SEARCH)
        draw_search();
    else if (technique == SURFACES)
        draw_surfaces();
    else {
        // The split view. We use the scissor test and not two viewports: the
        // scissor only limits which pixels each technique may write, while
        // the viewport, and so the conversion from world coordinates to the
        // screen, stays the same for both halves. Any cell boundary must then
        // cross the middle of the canvas without a break.
        const half = Math.floor(canvas.width / 2);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, half, canvas.height);
        draw_surfaces();
        gl.scissor(half, 0, canvas.width - half, canvas.height);
        draw_search();
        gl.disable(gl.SCISSOR_TEST);
    }

    // The markers are drawn last, so that they always stay on top of the
    // diagram.
    draw_sites();

    gl.useProgram(null);

    update_status();
}

loadShadersFromURLS(["quad.vert", "quad.frag", "surface.vert", "surface.frag", "site.vert", "site.frag"]).then(shaders => setup(shaders));
