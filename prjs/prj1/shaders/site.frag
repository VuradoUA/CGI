#version 300 es

precision highp float;

// Turns each square point into a round marker, as Q4 of the project
// statement suggests: gl_PointCoord goes from (0, 0) to (1, 1) across the
// point, so r is 0 at its centre and 1 on the inscribed circle. We draw a
// dark outline and a white ring around the site's own colour, so that the
// marker still stands out on top of a cell painted in that same colour.
//
// Instead of switching from one ring to the next at an exact radius, which
// leaves jagged edges, we blend them over the width of one pixel: fwidth(r)
// says by how much r changes from this pixel to the next. Outside the circle
// the marker fades out through its alpha, which app.js blends with the
// diagram underneath.

flat in vec3 v_color;

out vec4 color;

// 0 well inside radius edge, 1 well outside it, and a smooth ramp over the
// one pixel in between.
float step_out(float edge, float r) {
    float w = fwidth(r);
    return smoothstep(edge - w, edge, r);
}

void main() {
    float r = length(gl_PointCoord - 0.5f) * 2.0f;

    vec3 rgb = mix(v_color, vec3(1.0f), step_out(0.55f, r));    // white ring
    rgb = mix(rgb, vec3(0.0f), step_out(0.8f, r));              // dark outline
    float alpha = 1.0f - step_out(1.0f, r);                     // outside the circle

    if(alpha == 0.0f)
        discard;
    color = vec4(rgb, alpha);
}
