import os
FONT_DIR = os.environ.get("FONT_DIR", "C:/Windows/Fonts")  # needs arial/verdana/tahoma/calibri/times
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random, json, numpy as np
random.seed(1); np.random.seed(1)
FONTS = [FONT_DIR+"/arial.ttf", FONT_DIR+"/arialbd.ttf", FONT_DIR+"/verdana.ttf", FONT_DIR+"/tahoma.ttf"]
LABELS = [
  ("Paracetamol", ["PANADOL", "Tiap kaplet mengandung:", "Paracetamol 500 mg", "Simpan di bawah suhu 30C"]),
  ("Amoxicillin", ["Komposisi:", "Amoxicillin trihydrate setara", "dengan Amoxicillin 500 mg", "HARUS DENGAN RESEP DOKTER"]),
  ("Mefenamic acid", ["Asam Mefenamat 500 mg", "Tablet salut selaput", "Reg. No: GKL1234567890A1"]),
  ("Ibuprofen", ["Each tablet contains:", "Ibuprofen 400 mg", "Exp: 12/2027 Batch: 0123"]),
  ("Cetirizine", ["Cetirizine HCl 10 mg", "10 strip x 10 tablet", "Obat keras"]),
  ("Dextromethorphan", ["Tiap 5 ml mengandung:", "Dextromethorphan HBr 15 mg", "Guaifenesin 100 mg"]),
]
# style: (bg, fg, glare, blur_radius, noise, fontscale)
STYLES = {
 "clean":   ((245,245,240),(20,20,20),0,0.6,4,1.0),
 "blurry":  ((245,245,240),(20,20,20),0,2.2,4,1.0),
 "glare":   ((235,235,230),(30,30,30),1,0.8,6,1.0),
 "colored": ((250,200,60),(150,20,20),0,0.8,5,1.0),
 "inverse": ((20,70,160),(255,255,255),0,0.8,5,1.0),
 "small":   ((245,245,240),(20,20,20),0,0.7,5,0.55),
 "shadow":  ((240,240,235),(25,25,25),2,0.9,6,1.0),
}
W,H=1536,810
os.makedirs("imgs",exist_ok=True)
for li,(name,lines) in enumerate(LABELS):
  for sname,(bg,fg,glare,blur,noise,fs) in STYLES.items():
    img=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(img)
    font=ImageFont.truetype(FONTS[li%len(FONTS)], int(64*fs))
    y=int(H*0.12)
    for ln in lines:
      d.text((int(W*0.08)+random.randint(-10,10),y),ln,fill=fg,font=font); y+=int(110*fs)
    img=img.rotate(random.uniform(-2.5,2.5),resample=Image.BICUBIC,fillcolor=bg)
    a=np.asarray(img).astype(np.float32)
    yy,xx=np.mgrid[0:H,0:W]
    if glare==1:
      g=np.exp(-(((xx-W*0.6)/(W*0.18))**2+((yy-H*0.45)/(H*0.25))**2))*170
      a+=g[...,None]
    if glare==2:
      a*= (0.35+0.65*(xx/W))[...,None]
    img=Image.fromarray(np.clip(a,0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    a=np.asarray(img).astype(np.float32)+np.random.normal(0,noise,(H,W,3))
    img=Image.fromarray(np.clip(a,0,255).astype(np.uint8))
    img.save(f"imgs/{li}_{sname}_hi.png")
    # what the OLD app got: 640x480 stream -> crop is 1/3 the size
    img.resize((W//3,H//3),Image.BILINEAR).save(f"imgs/{li}_{sname}_lo.png")
EXP=[["Paracetamol 500 mg"],["Amoxicillin 500 mg"],["Mefenamic acid 500 mg"],["Ibuprofen 400 mg"],["Cetirizine 10 mg"],["Dextromethorphan 15 mg"]]
json.dump({f:EXP[int(f.split("_")[0])] for f in os.listdir("imgs") if f.endswith("_hi.png")},open("imgs/expected.json","w"),indent=1)
print(len(os.listdir("imgs")))
