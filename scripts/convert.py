#!/usr/bin/env python3
"""Mesh / CAD conversions used by Splat.

  convert.py step2stl  in.step out.stl [linear_tolerance_mm]
  convert.py mesh2stl  in.(obj|ply|off|3mf|glb|gltf|amf|stl) out.stl
  convert.py stl2mesh  in.stl out.(obj|ply|glb|3mf|off)
  convert.py stl2step  in.stl out.step
  convert.py info      in.(any mesh)          -> JSON stats on stdout
  convert.py zipdir    dir out.zip            (skips .git and .splat)
"""
import json
import os
import sys
import zipfile


def step2stl(src, dst, tol=0.05):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.StlAPI import StlAPI_Writer

    reader = STEPControl_Reader()
    if reader.ReadFile(src) != IFSelect_RetDone:
        raise SystemExit("could not read STEP file")
    reader.TransferRoots()
    shape = reader.OneShape()
    BRepMesh_IncrementalMesh(shape, float(tol), False, 0.3, True).Perform()
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    if not writer.Write(shape, dst):
        raise SystemExit("could not write STL")


def stl2step(src, dst):
    from OCP.StlAPI import StlAPI_Reader
    from OCP.TopoDS import TopoDS_Shape, TopoDS
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing, BRepBuilderAPI_MakeSolid
    from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.IFSelect import IFSelect_RetDone

    shape = TopoDS_Shape()
    if not StlAPI_Reader().Read(shape, src):
        raise SystemExit("could not read STL")
    sew = BRepBuilderAPI_Sewing(1e-4)
    sew.Add(shape)
    sew.Perform()
    sewn = sew.SewedShape()
    out = sewn
    try:
        exp = TopExp_Explorer(sewn, TopAbs_SHELL)
        mk = BRepBuilderAPI_MakeSolid()
        n = 0
        while exp.More():
            mk.Add(TopoDS.Shell_s(exp.Current()))
            n += 1
            exp.Next()
        if n:
            out = mk.Solid()
    except Exception:
        out = sewn
    writer = STEPControl_Writer()
    writer.Transfer(out, STEPControl_AsIs)
    if writer.Write(dst) != IFSelect_RetDone:
        raise SystemExit("could not write STEP")


def _load(src):
    import trimesh

    mesh = trimesh.load(src, force="mesh")
    if mesh.is_empty:
        raise SystemExit("mesh is empty")
    return mesh


def mesh2stl(src, dst):
    _load(src).export(dst, file_type="stl")


def stl2mesh(src, dst):
    ext = os.path.splitext(dst)[1].lstrip(".").lower()
    _load(src).export(dst, file_type=ext)


def info(src):
    m = _load(src)
    lo, hi = m.bounds
    print(json.dumps({
        "triangles": int(len(m.faces)),
        "min": [round(float(x), 3) for x in lo],
        "max": [round(float(x), 3) for x in hi],
        "size": [round(float(x), 3) for x in (hi - lo)],
        "watertight": bool(m.is_watertight),
        "volume": round(float(m.volume), 3) if m.is_watertight else None,
    }))


def zipdir(src, dst):
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in (".git", ".splat")]
            for f in files:
                if f == ".gitkeep":
                    continue
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, src))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    fn = {"step2stl": step2stl, "stl2step": stl2step, "mesh2stl": mesh2stl,
          "stl2mesh": stl2mesh, "info": info, "zipdir": zipdir}.get(cmd)
    if not fn:
        raise SystemExit(f"unknown command {cmd}")
    fn(*args)


if __name__ == "__main__":
    main()
