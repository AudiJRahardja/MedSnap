import os
FONT_DIR = os.environ.get("FONT_DIR", "C:/Windows/Fonts")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
# Labels whose text and background have (almost) the same luminance, as on some coloured
# packaging. Plain grayscale can't separate them; a single colour channel can.
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, json
np.random.seed(3)
COMBOS = {"green_on_red": ((200,40,40),(40,120,40)), "blue_on_orange": ((235,140,30),(20,90,230)),
          "red_on_teal": ((40,140,140),(230,40,40)), "purple_on_green": ((60,160,60),(170,40,200))}
LABELS = [["Ibuprofen 400 mg"], ["Cetirizine 10 mg"], ["Omeprazole 20 mg"], ["Ambroxol 30 mg"]]
os.makedirs("color", exist_ok=True)
exp = {}
for i, (name, (bg, fg)) in enumerate(COMBOS.items()):
    img = Image.new("RGB", (1536, 810), bg); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT_DIR + "/arialbd.ttf", 64)
    d.text((120, 200), LABELS[i][0], fill=fg, font=f); d.text((120, 320), "Tablet salut selaput", fill=fg, font=f)
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    a = np.asarray(img).astype(float) + np.random.normal(0, 5, (810, 1536, 3))
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(f"color/{name}.png")
    exp[f"{name}.png"] = LABELS[i]
json.dump(exp, open("color/expected.json", "w"), indent=1)
print(len(exp))
