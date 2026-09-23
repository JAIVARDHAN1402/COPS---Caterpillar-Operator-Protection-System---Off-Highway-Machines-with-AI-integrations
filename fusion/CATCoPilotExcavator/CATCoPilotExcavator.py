"""COPS (Caterpillar Operator Protection System): builds a twin-ready excavator in Fusion 360.

Run from Fusion 360: Utilities > Add-Ins > Scripts and Add-Ins > (+) > pick this folder > Run.

What makes it "twin-ready":
  * Each moving part is its own component, nested the way the machine moves:
        Base            (tracks, undercarriage)
        Upper           (swings on Y)           <- contains Cab, Engine, Boom
          Boom          (pitches on Z)          <- contains Stick
            Stick       (pitches on Z)          <- contains Bucket
              Bucket    (curls on Z)
  * Every component's ORIGIN sits on its real pivot pin, so rotating the
    component in the web app rotates it around the correct joint.
  * Names match what the Digital Twin tab searches for (Upper/Boom/Stick/Bucket/Engine/Cab),
    and the paint appearance is called "CAT_Paint" so the app can recolour it
    (gray beginner -> CAT yellow expert).

Coordinates: metres in this file (converted to Fusion's centimetres), Y is up,
the machine faces +X. You can restyle/refine every body afterwards - just keep
the component names, the nesting and the origins.
"""
import math
import os
import traceback

import adsk.core
import adsk.fusion

CM = 100.0  # Fusion API length unit is cm


def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        design = adsk.fusion.Design.cast(app.activeProduct)
        design.designType = adsk.fusion.DesignTypes.DirectDesignType  # lets us add B-Rep bodies directly
        root = design.rootComponent
        tb = adsk.fusion.TemporaryBRepManager.get()

        paint = make_appearance(app, design, "CAT_Paint", (255, 205, 17))
        dark = make_appearance(app, design, "CAT_Dark", (40, 41, 44))
        steel = make_appearance(app, design, "CAT_Steel", (140, 143, 148))
        glass = make_appearance(app, design, "CAT_Glass", (30, 45, 60))
        chrome = make_appearance(app, design, "CAT_Chrome", (205, 208, 212))

        def P(x, y, z):
            return adsk.core.Point3D.create(x * CM, y * CM, z * CM)

        def comp(parent, name, x, y, z, rot_z=0.0):
            """New component whose origin (= pivot) is at (x, y, z) in the parent, rotated about Z."""
            m = adsk.core.Matrix3D.create()
            if rot_z:
                m.setToRotation(rot_z, adsk.core.Vector3D.create(0, 0, 1), adsk.core.Point3D.create(0, 0, 0))
            m.translation = adsk.core.Vector3D.create(x * CM, y * CM, z * CM)
            occ = parent.occurrences.addNewComponent(m)
            occ.component.name = name
            return occ.component

        def add(c, body, name, appearance):
            b = c.bRepBodies.add(body)
            b.name = name
            if appearance:
                b.appearance = appearance
            return b

        def box(c, name, w, h, d, x, y, z, appearance):
            """Box of size w (X) x h (Y) x d (Z) centred at (x, y, z) in component space."""
            obb = adsk.core.OrientedBoundingBox3D.create(
                P(x, y, z), adsk.core.Vector3D.create(1, 0, 0), adsk.core.Vector3D.create(0, 1, 0),
                w * CM, h * CM, d * CM)
            return add(c, tb.createBox(obb), name, appearance)

        def cyl(c, name, p1, p2, r, appearance):
            return add(c, tb.createCylinderOrCone(P(*p1), r * CM, P(*p2), r * CM), name, appearance)

        # ---------------------------------------------------------------- Base / undercarriage
        base = comp(root, "Base", 0, 0, 0)
        for side, z in (("L", 1.2), ("R", -1.2)):
            box(base, f"Track_{side}", 4.4, 0.9, 0.75, 0, 0.45, z, dark)
            cyl(base, f"Sprocket_{side}", (-1.95, 0.45, z - 0.4), (-1.95, 0.45, z + 0.4), 0.42, steel)
            cyl(base, f"Idler_{side}", (1.95, 0.45, z - 0.4), (1.95, 0.45, z + 0.4), 0.4, steel)
            for i in range(5):
                x = -1.2 + i * 0.6
                cyl(base, f"Roller_{side}{i}", (x, 0.2, z - 0.42), (x, 0.2, z + 0.42), 0.14, steel)
        box(base, "CarBody", 2.2, 0.5, 1.6, 0, 0.7, 0, steel)
        cyl(base, "SwingBearing", (0, 0.85, 0), (0, 1.0, 0), 0.85, steel)

        # ---------------------------------------------------------------- Upper structure (swings)
        upper = comp(root, "Upper", 0, 1.0, 0)
        box(upper, "Deck", 3.4, 0.35, 2.6, -0.3, 0.2, 0, paint)
        box(upper, "Counterweight", 0.6, 1.0, 2.6, -2.0, 0.7, 0, dark)
        box(upper, "ToolBox", 1.2, 0.6, 0.9, -0.1, 0.65, -0.8, paint)
        cyl(upper, "Handrail", (-1.6, 1.25, -1.2), (0.4, 1.25, -1.2), 0.03, chrome)

        cab = comp(upper, "Cab", 0.75, 1.15, 0.75)
        box(cab, "CabShell", 1.1, 1.6, 1.0, 0, 0, 0, paint)
        box(cab, "Windshield", 0.05, 0.9, 0.85, 0.56, 0.3, 0, glass)
        box(cab, "SideWindow", 0.9, 0.9, 0.05, 0, 0.3, 0.51, glass)
        box(cab, "Roof", 1.2, 0.08, 1.1, 0, 0.84, 0, dark)

        engine = comp(upper, "Engine", -1.0, 0.75, -0.1)
        box(engine, "EngineHood", 1.5, 0.8, 2.2, 0, 0, 0, paint)
        cyl(engine, "Exhaust", (0.3, 0.4, -0.6), (0.3, 1.0, -0.6), 0.07, chrome)

        # ---------------------------------------------------------------- Front linkage (nested!)
        boom = comp(upper, "Boom", 1.0, 0.6, -0.2, rot_z=0.45)       # pivot = boom foot pin
        box(boom, "BoomBody", 5.2, 0.5, 0.45, 2.6, 0, 0, paint)
        cyl(boom, "BoomCylinder", (0.3, -0.45, 0), (2.8, -0.45, 0), 0.09, chrome)
        cyl(boom, "BoomFootPin", (0, 0, -0.3), (0, 0, 0.3), 0.08, steel)

        stick = comp(boom, "Stick", 5.2, 0, 0, rot_z=-1.9)            # pivot = boom nose pin
        box(stick, "StickBody", 3.0, 0.38, 0.35, 1.5, 0, 0, paint)
        cyl(stick, "StickCylinder", (-0.2, 0.35, 0), (2.2, 0.35, 0), 0.07, chrome)
        cyl(stick, "StickPin", (0, 0, -0.25), (0, 0, 0.25), 0.07, steel)

        bucket = comp(stick, "Bucket", 3.0, 0, 0, rot_z=-0.8)         # pivot = bucket pin
        box(bucket, "BucketShell", 0.9, 0.7, 1.0, 0.35, -0.25, 0, dark)
        for i in range(5):
            z = -0.4 + i * 0.2
            box(bucket, f"Tooth{i}", 0.2, 0.08, 0.1, 0.85, -0.55, z, steel)
        cyl(bucket, "BucketPin", (0, 0, -0.3), (0, 0, 0.3), 0.06, steel)

        app.activeViewport.fit()

        # ---------------------------------------------------------------- export (if the API supports FBX)
        target = default_export_path()
        exported = try_export_fbx(design, target)
        msg = ("COPS excavator created.\n\n"
               "Components: Base, Upper > (Cab, Engine, Boom > Stick > Bucket).\n"
               "Each component origin is on its pivot pin. Restyle freely, but keep names, nesting and origins.\n\n")
        if exported:
            msg += f"Exported FBX to:\n{target}\n\nOpen the Digital Twin tab in the app: it loads automatically."
        else:
            msg += ("Now export it: File > Export > Type: FBX (*.fbx)\n"
                    f"Save as:\n{target}\n\nThen open the Digital Twin tab in the app.")
        ui.messageBox(msg, "COPS")
    except Exception:
        if ui:
            ui.messageBox("Failed:\n{}".format(traceback.format_exc()))


def make_appearance(app, design, name, rgb):
    """Copy a glossy paint appearance from the library and recolour it. Returns None if unavailable."""
    try:
        existing = design.appearances.itemByName(name)
        if existing:
            return existing
        base = None
        for li in range(app.materialLibraries.count):
            lib = app.materialLibraries.item(li)
            if "appearance" not in lib.name.lower():
                continue
            for i in range(lib.appearances.count):
                a = lib.appearances.item(i)
                if "paint" in a.name.lower() and "gloss" in a.name.lower():
                    base = a
                    break
            if base:
                break
        if not base:
            return None
        ap = design.appearances.addByCopy(base, name)
        for i in range(ap.appearanceProperties.count):
            cp = adsk.core.ColorProperty.cast(ap.appearanceProperties.item(i))
            if cp:
                try:
                    cp.value = adsk.core.Color.create(rgb[0], rgb[1], rgb[2], 255)
                except Exception:
                    pass
        return ap
    except Exception:
        return None


def default_export_path():
    """frontend/public/models/excavator.fbx next to this script's repo, if it exists."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    models = os.path.join(repo, "frontend", "public", "models")
    if not os.path.isdir(models):
        models = os.path.join(os.path.expanduser("~"), "Desktop")
    return os.path.join(models, "excavator.fbx")


def try_export_fbx(design, path):
    """Newer Fusion versions expose FBX export in the API; older ones need File > Export."""
    em = design.exportManager
    create = getattr(em, "createFBXExportOptions", None)
    if not create:
        return False
    try:
        opts = create(path)
        return bool(em.execute(opts))
    except Exception:
        return False
