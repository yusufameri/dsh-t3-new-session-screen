#!/usr/bin/env python3
"""Encode a directory of PNG frames into an optimised GIF.

    python3 encode-gif.py <frames-dir> <out.gif> [--fps 3] [--width 1100]

Frames are downscaled to a shared palette so the result stays small enough to
sit in a README, and near-identical consecutive frames are dropped so a mostly
static interaction does not balloon the file.
"""

import argparse
import glob
import os
import sys

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("frames_dir")
    parser.add_argument("out")
    parser.add_argument("--fps", type=float, default=3.0)
    parser.add_argument("--width", type=int, default=1100)
    parser.add_argument("--max-frames", type=int, default=120)
    args = parser.parse_args()

    paths = sorted(glob.glob(os.path.join(args.frames_dir, "frame-*.png")))
    if not paths:
        print(f"no frames in {args.frames_dir}", file=sys.stderr)
        return 1

    # Even sampling keeps the pacing readable when there are more frames than
    # the cap allows.
    if len(paths) > args.max_frames:
        stride = len(paths) / args.max_frames
        paths = [paths[int(index * stride)] for index in range(args.max_frames)]

    delay_ms = int(1000 / args.fps)
    frames = []
    previous = None
    for path in paths:
        image = Image.open(path).convert("RGB")
        if image.width > args.width:
            ratio = args.width / image.width
            image = image.resize((args.width, int(image.height * ratio)), Image.LANCZOS)
        # Skip a frame that is visually identical to the one before it.
        signature = image.resize((32, 18), Image.BILINEAR).tobytes()
        if signature == previous:
            continue
        previous = signature
        frames.append(image.convert("P", palette=Image.ADAPTIVE, colors=128))

    if not frames:
        print("every frame was a duplicate", file=sys.stderr)
        return 1

    frames[0].save(
        args.out,
        save_all=True,
        append_images=frames[1:],
        duration=delay_ms,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size_kb = os.path.getsize(args.out) / 1024
    print(f"wrote {args.out} ({len(frames)} frames, {size_kb:.0f} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
