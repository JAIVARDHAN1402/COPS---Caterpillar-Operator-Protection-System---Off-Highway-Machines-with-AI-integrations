# Fusion 360 → COPS Digital Twin

The app's **🚜 Digital Twin** tab shows a 3D excavator driven by live data. It digs while
a task runs and freezes on any interlock. It also shows the swing danger zone, walkaround
hotspots, engine glow when idling, and paint that turns from gray to CAT yellow as the
operator's skill grows. It uses a built-in placeholder until you give it your Fusion 360 model.

## Option A: generate the model with the script (fastest, ~2 min)
1. In Fusion 360, open **Utilities → Add-Ins → Scripts and Add-Ins** (or press `Shift+S`).
2. On the **Scripts** tab, click **+** (the green plus) and select the folder
   `CAT/fusion/CATCoPilotExcavator`.
3. Select **CATCoPilotExcavator** and click **Run**. A new design opens with the excavator.
4. **Export:** File → **Export** → Type **FBX (\*.fbx)** → save as
   `CAT/frontend/public/models/excavator.fbx`.
   *(If your Fusion version supports FBX export from scripts, the script already saved it there and tells you so.)*
5. Open the app → **🚜 Digital Twin**. The model loads automatically, and the "Model source" card shows ✓ for each part it found.

You can now **restyle it freely**: add fillets, handrails, decals, a better cab. Keep the three rules below.

## Option B: your own model from scratch: the 3 rules
1. **Name the components** `Base`, `Upper`, `Boom`, `Stick`, `Bucket` (plus optional `Cab` and `Engine`).
2. **Nest them the way the machine moves:** `Upper` contains `Boom`, `Boom` contains `Stick`,
   and `Stick` contains `Bucket`. If they are not nested, the arm is shown but not animated.
3. **Put each component's origin on its pivot pin** (boom foot pin, boom nose pin, bucket pin; the swing
   centre for `Upper`). The app rotates each part around its origin.

Extras:
- Name the paint appearance with **"Paint"** or **"CAT_Paint"** in it, so the app can recolor it.
- Front of the machine = **+X**, up = **Y**. If it shows lying on its side, click **"Model is Z-up"** in the app.
- Size doesn't matter; the app scales the model to about 9.5 m long.

## Quick test without saving files
Drag an `.fbx`, `.glb` or `.obj` file straight onto the 3D view, or use **📂 Load**.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Model lies on its side | Click **↻ Model is Z-up** |
| Arm doesn't move | The components aren't nested (rule 2). The card shows "✗ Nested" |
| Boom swings around the wrong point | That component's origin isn't on the pin (rule 3) |
| Whole model is one colour / no yellow | Rename the paint appearance to include "Paint" |
| Nothing loads | Must be FBX/GLB/OBJ; check the file is at `frontend/public/models/excavator.fbx` |
