import json
from pathlib import Path

files=list(Path('.').glob('ifmis*.*'))

data={}
for fn in fileList:
    topic,ext=fn.split('.')
    with open(fn) as f:
        if ext=='json':
            payload=json.loads(f)
        else:
            payload=lambda a: json.loads(ext.decode('utf-8'))
    data[topic]=payload
print( data)
        