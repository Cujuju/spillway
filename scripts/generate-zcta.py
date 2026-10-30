"""Regenerate public-domain 2025 Census ZCTA internal points; Python standard library only.
Source: https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
Run: python scripts/generate-zcta.py
"""
import csv
import io
import json
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

SOURCE = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip'
with urlopen(SOURCE) as response, ZipFile(io.BytesIO(response.read())) as archive:
    with archive.open('2025_Gaz_zcta_national.txt') as raw:
        rows = csv.DictReader(io.TextIOWrapper(raw), delimiter='|')
        # Four decimals: approximately 11 metres, below the solar formula's precision.
        points = sorted([int(r['GEOID']), round(float(r['INTPTLAT']), 4), round(float(r['INTPTLONG']), 4)] for r in rows)
target = Path(__file__).resolve().parents[1] / 'src/renderer/src/lib/zcta.json'
target.write_text(json.dumps(points, separators=(',', ':')) + '\n', encoding='utf-8')
print(f'{len(points)} ZCTAs, {target.stat().st_size} bytes')
