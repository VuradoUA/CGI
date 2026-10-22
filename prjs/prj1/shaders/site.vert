#version 300 es

// Each vertex is one site, and reads no attribute at all: gl_VertexID tells
// it which site it is, and its position and colour come from the uniform
// arrays, which the search technique needs anyway. We convert the position
// to clip space as in ex16, with one addition: the visible half height of
// the world is the half width over the aspect ratio of the canvas.

const int MAX_SITES = 32;

uniform vec2 u_site_position[MAX_SITES];
uniform vec3 u_site_color[MAX_SITES];

uniform vec2 u_center;
uniform float u_scale;
uniform float u_world_half_width;
uniform float u_aspect;     // canvas width / canvas height

flat out vec3 v_color;

void main() {
    vec2 half_size = u_scale * u_world_half_width * vec2(1.0f, 1.0f / u_aspect);
    gl_Position = vec4((u_site_position[gl_VertexID] - u_center) / half_size, 0.0f, 1.0f);
    gl_PointSize = 14.0f;   // in pixels, whatever the zoom
    v_color = u_site_color[gl_VertexID];
}
