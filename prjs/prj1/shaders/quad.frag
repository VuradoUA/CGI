#version 300 es

precision highp float;

// The search technique: every pixel measures its distance to every site and
// keeps the nearest one, as the project statement describes in "Rendering
// technique 1".

const int MAX_SITES = 32;

uniform vec2 u_site_position[MAX_SITES];
uniform vec3 u_site_color[MAX_SITES];
uniform int u_n_sites;      // how many of MAX_SITES are actually in use
uniform int u_metric;       // 0 Euclidean, 1 Manhattan, 2 Chebyshev, 3 Minkowski
uniform float u_p;          // the exponent of the Minkowski metric

uniform bool u_borders;
uniform float u_border_width;   // in pixels, on each side of the boundary

// How much the colour of a cell darkens away from its site, from 0 (not at
// all) to 1. See shade() below.
uniform float u_shading;

// The tie-break shared with the surfaces technique: site i is treated as
// i * u_tie_bias farther away than it really is. See u_tie_bias in
// surface.vert for why both techniques need it.
uniform float u_tie_bias;

// The hybrid borders of the surfaces technique (see draw_surfaces() in
// app.js) reuse this shader as their last step. Then, instead of searching
// every site, it reads which sites are the nearest and the second nearest
// at this pixel from two textures, where the surfaces technique wrote them
// as index / 255, and only measures the distance to those two.
uniform bool u_hybrid;
uniform sampler2D u_first_index;
uniform sampler2D u_second_index;

in vec2 v_world;            // this pixel, in world coordinates

out vec4 color;

// Returns the distance between p and q under the current metric, with the
// three formulas of the project statement, plus the general Minkowski
// metric of its "Possible Challenges": (|dx|^p + |dy|^p)^(1/p), which is
// Manhattan at p = 1, Euclidean at p = 2, and tends to Chebyshev as p grows.
// We divide both terms by the largest one before raising them to the power
// p, and multiply it back afterwards, so that a large p cannot overflow.
float dist(vec2 p, vec2 q) {
    vec2 d = abs(p - q);
    if(u_metric == 1)
        return d.x + d.y;           // Manhattan
    if(u_metric == 2)
        return max(d.x, d.y);       // Chebyshev
    if(u_metric == 3) {             // Minkowski
        float m = max(d.x, d.y);
        if(m == 0.0f)
            return 0.0f;
        return m * pow(pow(d.x / m, u_p) + pow(d.y / m, u_p), 1.0f / u_p);
    }
    return length(p - q);           // Euclidean
}

// Returns the gradient of dist(p, q) with respect to p: the direction in
// which the distance grows fastest, scaled by how fast it grows per world
// unit. We need it to know how fast d2 - d1 changes across a boundary (see
// the borders in main()). Each metric has its own formula, which follows from
// differentiating the one in dist(); we keep a / d away from 0 before
// raising it to a power, because pow(0, 0) is undefined in GLSL.
vec2 dist_gradient(vec2 p, vec2 q) {
    vec2 v = p - q;
    vec2 a = abs(v);
    vec2 s = sign(v);
    if(u_metric == 1)
        return s;                                           // Manhattan
    if(u_metric == 2)
        return a.x > a.y ? vec2(s.x, 0.0f) : vec2(0.0f, s.y);  // Chebyshev
    float d = dist(p, q);
    if(d == 0.0f)
        return vec2(0.0f);
    if(u_metric == 3)                                       // Minkowski
        return s * pow(max(a / d, vec2(1.0e-20f)), vec2(u_p - 1.0f));
    return v / d;                                           // Euclidean
}

// Returns how much a colour is darkened at distance d from its site, as in
// the sample image of the project statement: 1 (no change) on the site
// itself, decreasing smoothly towards 1 - u_shading far away from it. The
// surfaces technique uses exactly the same function on the height of its
// surfaces, which is the same distance, so both still draw the same picture.
// SHADE_DISTANCE is how far, in world units, the darkening takes to reach
// about two thirds of its full strength.
const float SHADE_DISTANCE = 6.0f;

float shade(float d) {
    return 1.0f - u_shading * (1.0f - exp(-d / SHADE_DISTANCE));
}

// Reads the site index the surfaces technique wrote at this pixel.
int read_index(sampler2D indices) {
    return int(round(texelFetch(indices, ivec2(gl_FragCoord.xy), 0).r * 255.0f));
}

void main() {
    float d1 = 1.0e30f;     // distance to the nearest site found so far
    float d2 = 1.0e30f;     // distance to the second nearest
    int nearest = 0;
    int second = 0;

    if(u_hybrid) {
        nearest = read_index(u_first_index);
        second = read_index(u_second_index);
        d1 = dist(v_world, u_site_position[nearest]) + float(nearest) * u_tie_bias;
        // 255 means there is no second surface here: with a single site,
        // there is no border either
        if(second == 255)
            second = nearest;
        else
            d2 = dist(v_world, u_site_position[second]) + float(second) * u_tie_bias;
    }

    // GLSL ES needs a constant loop bound, so we loop up to MAX_SITES and
    // leave the loop as soon as we pass the sites actually in use.
    for(int i = 0; i < MAX_SITES && !u_hybrid; i++) {
        if(i >= u_n_sites)
            break;
        float d = dist(v_world, u_site_position[i]) + float(i) * u_tie_bias;

        // When a new nearest site is found, the old nearest becomes the
        // second nearest.
        if(d < d1) {
            d2 = d1;
            second = nearest;
            d1 = d;
            nearest = i;
        } else if(d < d2) {
            d2 = d;
            second = i;
        }
    }

    color = vec4(u_site_color[nearest] * shade(d1), 1.0f);

    // A pixel lies on a border when it is almost as far from the second
    // nearest site as from the nearest one: |d1 - d2| < epsilon (since d1 is
    // never greater than d2, d2 - d1 is already that absolute value).
    //
    // We choose epsilon per pixel: it is how much d2 - d1 changes over
    // u_border_width pixels at this point. That change is the length of the
    // gradient of d2 - d1, which is the gradient of the second nearest
    // distance minus that of the nearest one, times the size of one pixel in
    // world units. We get that size from dFdx(), which GLSL gives every
    // fragment shader: it says by how much v_world changes from this pixel
    // to the next one along x. Dividing d2 - d1 by the change per pixel gives
    // how many pixels this one is from the boundary, so epsilon follows the
    // zoom on its own, as the project statement asks, and the border keeps
    // the same width on the screen everywhere - with a fixed epsilon it
    // widens wherever d2 - d1 changes slowly. Instead of a hard yes or no,
    // which leaves jagged edges, we fade the border out over the last pixel
    // of its width, so that its edges are smooth.
    if(u_borders) {
        float world_per_pixel = length(dFdx(v_world));
        vec2 gradient = dist_gradient(v_world, u_site_position[second]) -
            dist_gradient(v_world, u_site_position[nearest]);
        float pixels = (d2 - d1) / (length(gradient) * world_per_pixel);
        float border = 1.0f - smoothstep(u_border_width - 1.0f, u_border_width, pixels);
        color.rgb = mix(color.rgb, vec3(1.0f), border);
    }
}
