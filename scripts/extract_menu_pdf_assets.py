"""Extract and web-optimize the food photos embedded in the HANA menu PDF.

The extraction order is tied to the first eleven pages of the integrated menu
PDF. Prices and text are intentionally ignored; Supabase remains the only
price source used by the QR ordering flow.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image
from pypdf import PdfReader


PHOTO_NAMES = (
    "shin-ramen",
    "seolleongtang",
    "yukgaejang",
    "spicy-beef-bone-greens",
    "rice-cake-dumpling-soup",
    "hot-stone-roe-rice",
    "spicy-pork-rice",
    "dageumbari-sashimi-rice",
    "cold-noodles",
    "soft-tofu-stew",
    "kimchi-stew",
    "soybean-paste-stew",
    "jjapagetti",
    "buldak-noodles",
    "bibim-noodles",
    "myeongdong-kalguksu",
    "pork-soup-rice",
    "ox-knee-soup",
    "chuck-flap-steak",
    "salmon-steak",
    "kimchi-hot-pot",
    "snail-wrap-rice",
    "spicy-pork-lettuce",
    "grilled-pork-belly",
    "smoked-duck",
    "assorted-boiled-meat-hotpot",
    "fish-cake-soup",
    "dageumbari-spicy-salad",
    "beef-tartare",
    "spicy-chicken-feet",
    "grilled-spam",
    "fried-chicken",
    "grilled-scallops",
    "tteokbokki",
    "fried-shrimp",
    "webfoot-octopus-salad",
    "boiled-pork-aged-kimchi-tofu",
    "braised-pork-ribs-kimchi",
    "spicy-braised-chicken",
    "artichoke-chicken-crispy-rice",
    "dageumbari-sashimi-set",
    "soju",
    "beer",
    "soft-drink",
    "makgeolli",
    "vodka-men",
    "nep-moi",
    "red-wine",
    "white-wine",
    "highball",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    reader = PdfReader(args.pdf)
    images = [image for page in reader.pages[:12] for image in page.images]
    if len(images) != len(PHOTO_NAMES):
        raise RuntimeError(
            f"Expected {len(PHOTO_NAMES)} food photos, found {len(images)}"
        )

    args.output.mkdir(parents=True, exist_ok=True)
    for name, embedded in zip(PHOTO_NAMES, images, strict=True):
        image: Image.Image = embedded.image
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGB")
        elif image.mode == "RGBA":
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        else:
            image = image.copy()

        image.thumbnail((960, 960), Image.Resampling.LANCZOS)
        image.save(args.output / f"{name}.webp", "WEBP", quality=82, method=6)

    print(f"Extracted {len(images)} menu photos to {args.output}")


if __name__ == "__main__":
    main()
