const VERTEX_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const BLOOM_EXTRACT_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_threshold;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float brightness = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  fragColor = brightness > u_threshold ? c : vec4(0.0);
}`;

const BLUR_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() {
  vec2 texel = u_dir / u_resolution;
  vec4 sum = vec4(0.0);
  sum += texture(u_tex, v_uv - 4.0 * texel) * 0.0162;
  sum += texture(u_tex, v_uv - 3.0 * texel) * 0.0540;
  sum += texture(u_tex, v_uv - 2.0 * texel) * 0.1216;
  sum += texture(u_tex, v_uv - 1.0 * texel) * 0.1945;
  sum += texture(u_tex, v_uv) * 0.2270;
  sum += texture(u_tex, v_uv + 1.0 * texel) * 0.1945;
  sum += texture(u_tex, v_uv + 2.0 * texel) * 0.1216;
  sum += texture(u_tex, v_uv + 3.0 * texel) * 0.0540;
  sum += texture(u_tex, v_uv + 4.0 * texel) * 0.0162;
  fragColor = sum;
}`;

const COMBINE_CA_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomIntensity;
uniform float u_caStrength;
out vec4 fragColor;
void main() {
  vec2 center = vec2(0.5);
  vec2 offset = (v_uv - center) * u_caStrength;
  float r = texture(u_scene, v_uv + offset).r;
  float g = texture(u_scene, v_uv).g;
  float b = texture(u_scene, v_uv - offset).b;
  vec3 scene = vec3(r, g, b);
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  fragColor = vec4(scene + bloom * u_bloomIntensity, 1.0);
}`;

export class PostFX {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private extractProg: WebGLProgram | null = null;
  private blurProg: WebGLProgram | null = null;
  private combineProg: WebGLProgram | null = null;
  private sceneTex: WebGLTexture | null = null;
  private fbos: Array<{ fb: WebGLFramebuffer; tex: WebGLTexture }> = [];
  private vao: WebGLVertexArrayObject | null = null;
  private halfW = 0;
  private halfH = 0;

  constructor() {}

  init(container: HTMLElement, w: number, h: number): boolean {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
    container.appendChild(canvas);
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!gl) return false;
    this.gl = gl;

    this.extractProg = this.createProgram(VERTEX_SRC, BLOOM_EXTRACT_SRC);
    this.blurProg = this.createProgram(VERTEX_SRC, BLUR_SRC);
    this.combineProg = this.createProgram(VERTEX_SRC, COMBINE_CA_SRC);
    if (!this.extractProg || !this.blurProg || !this.combineProg) return false;

    // Fullscreen quad
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.sceneTex = this.createTexture(w, h);
    this.halfW = Math.floor(w / 2);
    this.halfH = Math.floor(h / 2);
    // Ping-pong FBOs at half resolution
    for (let i = 0; i < 2; i++) {
      const tex = this.createTexture(this.halfW, this.halfH);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbos.push({ fb, tex });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return true;
  }

  resize(w: number, h: number) {
    if (!this.gl || !this.canvas) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.halfW = Math.floor(w / 2);
    this.halfH = Math.floor(h / 2);
    const gl = this.gl;
    // Recreate textures
    if (this.sceneTex) { gl.deleteTexture(this.sceneTex); }
    this.sceneTex = this.createTexture(w, h);
    for (const fbo of this.fbos) {
      gl.deleteTexture(fbo.tex);
      fbo.tex = this.createTexture(this.halfW, this.halfH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbo.tex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(sourceCanvas: HTMLCanvasElement, bloomIntensity: number, caStrength: number) {
    const gl = this.gl;
    if (!gl || !this.sceneTex) return;

    // Upload source to texture
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

    gl.bindVertexArray(this.vao);

    // 1. Extract bright pixels
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[0].fb);
    gl.viewport(0, 0, this.halfW, this.halfH);
    gl.useProgram(this.extractProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(gl.getUniformLocation(this.extractProg!, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(this.extractProg!, 'u_threshold'), 0.65);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. Blur horizontal
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1].fb);
    gl.useProgram(this.blurProg);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    gl.uniform1i(gl.getUniformLocation(this.blurProg!, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.blurProg!, 'u_dir'), 1.0, 0.0);
    gl.uniform2f(gl.getUniformLocation(this.blurProg!, 'u_resolution'), this.halfW, this.halfH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Blur vertical
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[0].fb);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[1].tex);
    gl.uniform2f(gl.getUniformLocation(this.blurProg!, 'u_dir'), 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 4. Combine: scene + bloom + chromatic aberration → screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas!.width, this.canvas!.height);
    gl.useProgram(this.combineProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(gl.getUniformLocation(this.combineProg!, 'u_scene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[0].tex);
    gl.uniform1i(gl.getUniformLocation(this.combineProg!, 'u_bloom'), 1);
    gl.uniform1f(gl.getUniformLocation(this.combineProg!, 'u_bloomIntensity'), bloomIntensity);
    gl.uniform1f(gl.getUniformLocation(this.combineProg!, 'u_caStrength'), caStrength);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    if (!this.gl) return;
    const gl = this.gl;
    for (const fbo of this.fbos) {
      gl.deleteFramebuffer(fbo.fb);
      gl.deleteTexture(fbo.tex);
    }
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.extractProg) gl.deleteProgram(this.extractProg);
    if (this.blurProg) gl.deleteProgram(this.blurProg);
    if (this.combineProg) gl.deleteProgram(this.combineProg);
    this.canvas?.remove();
    this.gl = null;
  }

  private createTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createProgram(vSrc: string, fSrc: string): WebGLProgram | null {
    const gl = this.gl!;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fSrc);
    gl.compileShader(fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('PostFX shader link failed:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }
}
