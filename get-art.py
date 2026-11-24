#!/usr/bin/env python3
"""Download the official logo and two wallpapers from Rockstar into art/.

The files come straight from Rockstar's servers to your computer. They belong to
Rockstar Games and are for personal, non-commercial use. Don't commit or rehost them.
Needs Python 3 and no other packages. Only the needed parts of the zip are fetched.
"""
import io
import pathlib
import urllib.request
import zipfile

ZIP = ("https://media-rockstargames-com.akamaized.net/VI/downloads/"
       "artwork_wallpapers/GTAVI_Artwork_Wallpapers.zip")
LOGO = "https://www.rockstargames.com/VI/_next/static/media/vi.0hxa9~pf214xe.png"
WALLPAPERS = {
    "Jason_and_Lucia_Beach/Jason_and_Lucia_Beach_landscape.jpg": "hero.jpg",
    "Jason_and_Lucia_Rooftop/Jason_Lucia_Rooftop_landscape.jpg": "clips.jpg",
}
ART = pathlib.Path(__file__).resolve().parent / "art"


class RemoteFile(io.RawIOBase):
    """Reads a file over HTTP in ranges, so the whole zip isn't downloaded."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        with self._get(0, 0) as r:
            self.size = int(r.headers["Content-Range"].rsplit("/", 1)[1])

    def _get(self, first, last):
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={first}-{last}"})
        r = urllib.request.urlopen(req, timeout=60)
        if r.status != 206:
            r.close()
            raise OSError("the server doesn't support partial downloads")
        return r

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset + (0, self.pos, self.size)[whence]
        return self.pos

    def readinto(self, buf):
        n = min(len(buf), self.size - self.pos)
        if n <= 0:
            return 0
        with self._get(self.pos, self.pos + n - 1) as r:
            data = r.read()
        buf[:len(data)] = data
        self.pos += len(data)
        return len(data)


def save(name, data, magic):
    if not data.startswith(magic):
        raise ValueError("the download isn't an image")
    (ART / name).write_bytes(data)
    print(f"Saved art/{name}")


def main():
    ART.mkdir(exist_ok=True)
    failed = False
    try:
        with zipfile.ZipFile(io.BufferedReader(RemoteFile(ZIP), 1 << 20)) as z:
            for inside, name in WALLPAPERS.items():
                save(name, z.read(inside), b"\xff\xd8")
    except Exception as err:
        failed = True
        print(f"Couldn't get the wallpapers: {err}")
    try:
        with urllib.request.urlopen(LOGO, timeout=60) as r:
            save("logo.png", r.read(), b"\x89PNG")
    except Exception as err:
        failed = True
        print(f"Couldn't get the logo: {err}")
    if failed:
        print("Rockstar may have moved a file. Get it yourself from "
              "https://www.rockstargames.com/VI/media/artwork-wallpapers (see art/README.md).")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
