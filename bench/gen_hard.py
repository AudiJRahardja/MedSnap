import os
FONT_DIR = os.environ.get("FONT_DIR", "C:/Windows/Fonts")  # needs arial/verdana/tahoma/calibri/times
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random, json, numpy as np
random.seed(7); np.random.seed(7)
F = [FONT_DIR+"/arial.ttf",FONT_DIR+"/arialbd.ttf",FONT_DIR+"/verdana.ttf",FONT_DIR+"/tahoma.ttf",FONT_DIR+"/calibri.ttf",FONT_DIR+"/times.ttf"]
LABELS = [
 (["Paracetamol 500 mg","Caffeine 50 mg"], ["BODREX","Tiap tablet mengandung:","Paracetamol 500 mg","Caffeine 50 mg","Simpan di tempat sejuk dan kering"]),
 (["Paracetamol 650 mg","Phenylephrine 5 mg","Chlorpheniramine maleate 2 mg","Dextromethorphan 15 mg"],
   ["Komposisi tiap kaplet:","Paracetamol 650 mg","Phenylephrine HCl 5 mg","Chlorpheniramine maleate 2 mg","Dextromethorphan HBr 15 mg"]),
 (["Amoxicillin 500 mg"], ["Amoxicillin 500 mg","Kapsul","HARUS DENGAN RESEP DOKTER","Reg: DKL0123456789A1"]),
 (["Metformin 500 mg"], ["Metformin HCl 500 mg","tablet salut selaput","Exp 03/2028"]),
 (["Amlodipine 10 mg"], ["Amlodipine besylate","setara Amlodipine 10 mg","30 tablet"]),
 (["Ambroxol 30 mg"], ["Ambroxol HCl 30 mg","Mukolitik","Obat keras"]),
 (["Omeprazole 20 mg"], ["Omeprazole 20 mg","kapsul lepas tunda","Simpan di bawah 25C"]),
 (["Loperamide 2 mg"], ["Loperamide HCl 2 mg","Antidiare","Baca aturan pakai"]),
]
STY = {
 # bg, fg, blur, noise, fontscale, rot, extra
 "sideways": ((245,245,240),(20,20,20),0.8,5,0.9,90,None),
 "tiny":     ((245,245,240),(30,30,30),0.6,5,0.38,1.5,None),
 "heavyblur":((245,245,240),(20,20,20),3.2,4,1.0,1,None),
 "lowlight": ((90,88,80),(15,15,15),1.0,14,0.9,-1,None),
 "skew":     ((240,240,235),(25,25,25),0.8,5,0.9,6.5,None),
 "clutter":  ((250,250,250),(10,40,120),0.8,5,0.8,-2,"clutter"),
 "whiteblue":((30,80,170),(255,255,255),1.0,8,0.7,2,"glare"),
 "photo":    ((240,240,235),(25,25,25),1.2,6,0.9,1.5,"photo"),
}
W,H=1536,810
os.makedirs("hard",exist_ok=True)
exp={}
for li,(meds,lines) in enumerate(LABELS):
  for sn,(bg,fg,blur,noise,fs,rot,extra) in STY.items():
    font=ImageFont.truetype(F[(li+len(sn))%len(F)], int(60*fs))
    lh=int(84*fs)
    img=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(img)
    if extra=="clutter":
      for k in range(6):
        c=tuple(random.randint(0,255) for _ in range(3))
        x=random.randint(0,W); y=random.randint(0,H)
        d.ellipse((x,y,x+random.randint(60,300),y+random.randint(60,300)),fill=c)
      d.rectangle((0,H-120,W,H),fill=(200,30,40)); d.text((40,H-110),"PT FARMA SEHAT INDONESIA",fill=(255,255,255),font=ImageFont.truetype(F[1],60))
    y=int(H*0.1) if fs>0.5 else int(H*0.3)
    x0=int(W*0.07) if fs>0.5 else int(W*0.35)
    if extra=="clutter":
      d.rectangle((x0-20,y-20,x0+int(1100*fs),y+lh*len(lines)+10),fill=(250,250,250))
    for ln in lines:
      d.text((x0,y),ln,fill=fg,font=font); y+=lh
    img=img.rotate(rot,resample=Image.BICUBIC,expand=(rot==90),fillcolor=bg)
    if rot==90: img=img.resize((W,H)) if False else img
    a=np.asarray(img).astype(np.float32); h,w=a.shape[:2]
    if extra=="glare":
      yy,xx=np.mgrid[0:h,0:w]; a+=(np.exp(-(((xx-w*0.5)/(w*0.2))**2+((yy-h*0.4)/(h*0.3))**2))*90)[...,None]
    img=Image.fromarray(np.clip(a,0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
    if extra=="photo":
      # full gallery photo: 4032x3024 with the label occupying the middle ~45%
      big=Image.new("RGB",(4032,3024),(120,100,80)); bd=ImageDraw.Draw(big)
      for k in range(20):
        c=tuple(random.randint(40,200) for _ in range(3)); x=random.randint(0,4032); yv=random.randint(0,3024)
        bd.rectangle((x,yv,x+400,yv+300),fill=c)
      lab=img.resize((int(4032*0.48),int(4032*0.48*img.height/img.width)))
      big.paste(lab,(1100,1000)); img=big.filter(ImageFilter.GaussianBlur(1.5))
    a=np.asarray(img).astype(np.float32); a+=np.random.normal(0,noise,a.shape)
    img=Image.fromarray(np.clip(a,0,255).astype(np.uint8))
    fn=f"{li}_{sn}.png"; img.save("hard/"+fn); exp[fn]=meds
json.dump(exp,open("hard/expected.json","w"),indent=1)
print(len(exp))
