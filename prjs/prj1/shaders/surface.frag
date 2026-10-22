#version 300 es

precision highp float;

// By the time a fragment gets here, the depth test has already decided which
// surface is the lowest at this pixel, so there is no distance to compare at
// all. What we write depends on u_pass (see draw_surfaces() in app.js):
//
// - 0: the colour of the site, shaded by the height of the surface;
// - 1: the index of the site, which the depth test makes the nearest one;
// - 2: the index of the site again, but every surface discards the pixels
//   where pass 1 found it to be the nearest, so that the depth test now
//   keeps the second lowest surface: the second nearest site.
//
// An index is written to the red channel of an 8-bit texture as
// index / 255, which stores every index up to 255 exactly.

uniform float u_shading;
uniform int u_pass;
uniform sampler2D u_first_index;    // the result of pass 1, read in pass 2

flat in vec3 v_color;
in float v_height;          // the distance to the site, interpolated
flat in int v_site;         // which site this surface belongs to

out vec4 color;

// The same shading as in quad.frag, applied to the height of the surface,
// which is the distance to its site: both techniques must darken every pixel
// by the same amount to keep drawing the same picture.
const float SHADE_DISTANCE = 6.0f;

float shade(float d) {
    return 1.0f - u_shading * (1.0f - exp(-d / SHADE_DISTANCE));
}

void main() {
    if(u_pass == 0) {
        color = vec4(v_color * shade(v_height), 1.0f);
        return;
    }

    if(u_pass == 2) {
        // texelFetch reads exactly the texel of this pixel, with no
        // filtering: the texture is as large as the canvas
        float first = texelFetch(u_first_index, ivec2(gl_FragCoord.xy), 0).r;
        if(int(round(first * 255.0f)) == v_site)
            discard;
    }

    color = vec4(float(v_site) / 255.0f, 0.0f, 0.0f, 1.0f);
}
