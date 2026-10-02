import os
FONT_DIR = os.environ.get("FONT_DIR", "C:/Windows/Fonts")  # needs arial/verdana/tahoma/calibri/times
os.chdir(os.path.dirname(os.path.abspath(__file__)))
# Build a fake-webcam video (Y4M) showing a medicine label, slightly shaky, for Chrome's fake camera.
from PIL import Image, ImageDraw, ImageFont
import numpy as np
W,H=1280,720
base=Image.new("RGB",(W,H),(70,60,50)); d=ImageDraw.Draw(base)
d.rounded_rectangle((330,120,950,600),radius=20,fill=(248,246,240))
f=ImageFont.truetype(FONT_DIR+"/arial.ttf",34); fb=ImageFont.truetype(FONT_DIR+"/arialbd.ttf",44)
d.text((370,150),"NEOZEP Forte",fill=(200,30,40),font=fb)
y=230
for ln in ["Komposisi tiap tablet:","Paracetamol 250 mg","Phenylephrine HCl 10 mg","Chlorpheniramine maleate 2 mg","Simpan di tempat kering"]:
    d.text((370,y),ln,fill=(25,25,25),font=f); y+=58
base=base.rotate(-3,resample=Image.BICUBIC,fillcolor=(70,60,50))
with open("label.y4m","wb") as out:
    out.write(b"YUV4MPEG2 W1280 H720 F30:1 Ip A1:1 C420jpeg\n")
    rng=np.random.default_rng(0)
    for i in range(60):
        dx,dy=int(rng.integers(-3,4)),int(rng.integers(-3,4))
        fr=Image.new("RGB",(W,H),(70,60,50)); fr.paste(base,(dx,dy))
        ycc=np.asarray(fr.convert("YCbCr"))
        out.write(b"FRAME\n"); out.write(ycc[:,:,0].tobytes())
        out.write(ycc[::2,::2,1].tobytes()); out.write(ycc[::2,::2,2].tobytes())
base.save("label_frame.png"); print("ok")
