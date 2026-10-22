#version 300 es

// The corners of the quad are already in clip space, so they pass straight
// through.

in vec2 a_position;

// The view, exactly as in site.vert.
uniform vec2 u_center;
uniform float u_scale;
uniform float u_world_half_width;
uniform float u_aspect;     // canvas width / canvas height

// The world position of each corner. We pass it to the fragment shader as a
// varying, as in ex09, and let the rasteriser interpolate it: since the
// conversion from clip space to world coordinates is linear, the
// interpolated value is exactly the world position of every pixel.
out vec2 v_world;

void main() {
    gl_Position = vec4(a_position, 0.0f, 1.0f);

    // The inverse of the conversion in site.vert: from clip space back to
    // world coordinates.
    vec2 half_size = u_scale * u_world_half_width * vec2(1.0f, 1.0f / u_aspect);
    v_world = u_center + a_position * half_size;
}
