#version 300 es

// The surfaces technique, as the project statement describes in "Rendering
// technique 2". Every instance is one site, and every vertex is one point of
// that site's surface, whose height is the distance to the site. Nothing is
// read from a buffer: gl_InstanceID tells us which site we are building a
// surface for, and gl_VertexID which point of it this vertex is.
//
// We draw each surface as a gl.TRIANGLE_FAN: vertex 0 is the apex, on the
// site itself, at height 0; vertices 1 to u_rim_vertices + 1 go around the
// rim, at height u_height, and the last one repeats the first to close the
// fan. The shape of the rim is the only thing that changes with the metric:
//
// - Chebyshev: 4 vertices at the corners (+-R, +-R) of a square, which we
//   get from a circle of radius R * sqrt(2) rotated by 45 degrees;
// - Manhattan: 4 vertices at (+-R, 0) and (0, +-R), the corners of a
//   diamond, which we get from a circle of radius R with no rotation;
// - Euclidean: many vertices on a circle of radius R, approximating a cone;
// - Minkowski: as many vertices, each one moved along its direction until
//   its Minkowski distance to the site is exactly R.
//
// In all cases every rim vertex is at distance R from the site under its
// own metric, so its height is R. Between the apex and the rim the
// Chebyshev and Manhattan distances grow linearly on each face, which is why
// those two pyramids are exact.
//
// The cone is not exact. Its rim is a polygon inscribed in the circle of
// radius R, so between two rim vertices the edge of each face cuts inside
// the circle, and yet keeps height R: there the surface is slightly higher
// than the true distance, by up to a factor of 1 / cos(PI / sides) halfway
// between two rim vertices. This error depends on the direction from the
// site, so two neighbouring cones are off by different amounts along their
// boundary, which moves it by a fraction of a pixel. With 128 sides the
// factor is about 1.0003, and both techniques disagree only on a few
// isolated pixels along the Euclidean boundaries. The Minkowski surface is
// approximate in the same way, except at p = 1, where its rim vertices fall
// on the straight sides of the diamond and it becomes exact again.

const int MAX_SITES = 32;
const float PI = 3.14159265f;

uniform vec2 u_site_position[MAX_SITES];
uniform vec3 u_site_color[MAX_SITES];

uniform vec2 u_center;
uniform float u_scale;
uniform float u_world_half_width;
uniform float u_aspect;     // canvas width / canvas height

uniform int u_metric;       // 0 Euclidean, 1 Manhattan, 2 Chebyshev, 3 Minkowski
uniform float u_p;          // the exponent of the Minkowski metric
uniform int u_rim_vertices; // how many vertices go around the rim
uniform float u_height;     // R: the height of the rim, the same for all sites

// Where two sites are at exactly the same distance from a pixel - along
// some cell boundaries, and over whole areas with the Manhattan metric -
// the depth test would pick either surface depending on how each depth
// happened to be rounded, while the search technique would always pick the
// same one. We raise surface i by i * u_tie_bias, a tiny height, and the
// search technique adds the same amount to the distance of site i, so that
// both break every tie the same way: the site with the lowest index wins.
uniform float u_tie_bias;

flat out vec3 v_color;

// The height of the surface, which is the distance to the site, so that the
// fragment shader can shade the colour exactly as the search technique does.
// Unlike the colour, it must be interpolated across each face.
out float v_height;

// Which site this surface belongs to, for the hybrid borders in
// surface.frag. An integer cannot be interpolated, so it must be flat.
flat out int v_site;

void main() {
    vec2 site = u_site_position[gl_InstanceID];
    vec2 p = site;
    float h = 0.0f;

    if(gl_VertexID > 0) {
        // The % makes the last vertex land exactly on the first, so that the
        // fan closes without a crack.
        int k = (gl_VertexID - 1) % u_rim_vertices;
        float angle = 2.0f * PI * float(k) / float(u_rim_vertices);
        float radius = u_height;
        vec2 direction = vec2(cos(angle), sin(angle));
        if(u_metric == 2) {
            angle += PI / 4.0f;
            radius *= sqrt(2.0f);
            direction = vec2(cos(angle), sin(angle));
        } else if(u_metric == 3) {
            // The direction has Minkowski length (|cos|^p + |sin|^p)^(1/p),
            // so we divide R by it to land at Minkowski distance R.
            vec2 a = abs(direction);
            radius /= pow(pow(a.x, u_p) + pow(a.y, u_p), 1.0f / u_p);
        }
        p = site + radius * direction;
        h = u_height;
    }

    h += float(gl_InstanceID) * u_tie_bias;

    // The position is converted to clip space as in site.vert. The height
    // becomes the depth: we divide it by u_height, the same for every site,
    // so that every surface ends up between 0 (at its site) and 1 (on its
    // rim), and the depth test keeps the lowest surface at every pixel.
    vec2 half_size = u_scale * u_world_half_width * vec2(1.0f, 1.0f / u_aspect);
    gl_Position = vec4((p - u_center) / half_size, h / u_height, 1.0f);
    v_color = u_site_color[gl_InstanceID];
    v_height = h;
    v_site = gl_InstanceID;
}
