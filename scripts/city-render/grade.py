# The last pass on a render: a soft glow round the brightest lights and a light vignette.
#   python grade.py <in.png> <out.png|out.webp>
import sys
import numpy as np
from PIL import Image, ImageFilter


def grade(src, vignette=0.22):
    im = Image.open(src)
    a = np.asarray(im).astype(np.float32)
    a = a / (65535.0 if a.max() > 255 else 255.0)
    rgb = a[..., :3]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    bright = np.clip((lum - 0.72) / 0.28, 0, 1)[..., None] * rgb
    glow = np.zeros_like(rgb)
    scale = max(im.size) / 1600.0
    for radius, weight in ((6, 0.45), (18, 0.35), (48, 0.3)):
        b = Image.fromarray((np.clip(bright, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius * scale))
        glow += np.asarray(b).astype(np.float32) / 255.0 * weight
    out = 1 - (1 - rgb) * (1 - np.clip(glow, 0, 1))   # screen
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    out *= (1 - vignette * np.clip(r - 0.55, 0, 1) ** 1.5)[..., None]
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


def sharpen(img, amount=55):
    """A light unsharp mask, so the island holds its edges at full zoom (the review: soft at max zoom)."""
    return img.filter(ImageFilter.UnsharpMask(radius=1.2, percent=amount, threshold=2))


def save(img, dst, quality=84):
    if dst.lower().endswith('.webp'):
        img.save(dst, quality=quality, method=6)
    else:
        img.save(dst)


if __name__ == '__main__':
    out = grade(sys.argv[1])
    save(out, sys.argv[2])
    print('graded', sys.argv[2], out.size)
