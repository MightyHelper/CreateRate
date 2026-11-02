export type RasterVertex = { x: number; y: number; depth: number; u: number; v: number };
export type RasterTriangle = { texture: string; shade: number; vertices: [RasterVertex, RasterVertex, RasterVertex] };
export type RasterModel = { href: string; width: number; height: number };

const textures = new Map<string, Promise<ImageData>>();

export async function rasterizeModel(triangles: RasterTriangle[], bounds: { x: number; y: number; width: number; height: number }, resolution = 256): Promise<RasterModel | undefined> {
  if (!triangles.length || !bounds.width || !bounds.height) return undefined;
  try {
    const width = Math.max(1, Math.round(resolution * bounds.width / Math.max(bounds.width, bounds.height)));
    const height = Math.max(1, Math.round(resolution * bounds.height / Math.max(bounds.width, bounds.height)));
    const loaded = await Promise.all([...new Set(triangles.map(({ texture }) => texture))].map(async (url) => [url, await loadTexture(url)] as const));
    const images = new Map(loaded);
    const colors = new Uint8ClampedArray(width * height * 4);
    const depths = new Float32Array(width * height).fill(-Infinity);
    for (const triangle of triangles) {
      const texture = images.get(triangle.texture);
      if (!texture) continue;
      drawTriangle(colors, depths, width, height, bounds, triangle, texture);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.putImageData(new ImageData(colors, width, height), 0, 0);
    return { href: canvas.toDataURL("image/png"), width, height };
  } catch {
    return undefined;
  }
}

function loadTexture(url: string): Promise<ImageData> {
  let image = textures.get(url);
  if (!image) {
    image = new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) { reject(new Error("Canvas is unavailable")); return; }
        context.drawImage(element, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      };
      element.onerror = () => reject(new Error(`Could not load model texture: ${url}`));
      element.src = url;
    });
    textures.set(url, image);
    image.catch(() => textures.delete(url));
  }
  return image;
}

function drawTriangle(output: Uint8ClampedArray, depths: Float32Array, width: number, height: number, bounds: { x: number; y: number; width: number; height: number }, triangle: RasterTriangle, texture: ImageData) {
  const vertices = triangle.vertices.map(({ x, y, ...rest }) => ({
    ...rest,
    x: (x - bounds.x) / bounds.width * width,
    y: (y - bounds.y) / bounds.height * height,
  })) as [RasterVertex, RasterVertex, RasterVertex];
  const [a, b, c] = vertices;
  const area = edge(a, b, c.x, c.y);
  if (Math.abs(area) < 1e-8) return;
  const left = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const top = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const px = x + 0.5, py = y + 0.5;
    const wa = edge(b, c, px, py) / area, wb = edge(c, a, px, py) / area, wc = 1 - wa - wb;
    if (wa < 0 || wb < 0 || wc < 0) continue;
    const index = y * width + x;
    const depth = wa * a.depth + wb * b.depth + wc * c.depth;
    if (depth <= depths[index]) continue;
    const u = wa * a.u + wb * b.u + wc * c.u;
    const v = wa * a.v + wb * b.v + wc * c.v;
    const tx = Math.max(0, Math.min(texture.width - 1, Math.floor(u / 16 * texture.width)));
    const ty = Math.max(0, Math.min(texture.height - 1, Math.floor(v / 16 * texture.height)));
    const source = (ty * texture.width + tx) * 4, target = index * 4;
    const alpha = texture.data[source + 3];
    if (!alpha) continue;
    depths[index] = depth;
    const shade = 1 - triangle.shade;
    output[target] = texture.data[source] * shade;
    output[target + 1] = texture.data[source + 1] * shade;
    output[target + 2] = texture.data[source + 2] * shade;
    output[target + 3] = alpha;
  }
}

function edge(a: Pick<RasterVertex, "x" | "y">, b: Pick<RasterVertex, "x" | "y">, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}
