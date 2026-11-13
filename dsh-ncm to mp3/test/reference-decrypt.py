# -*- coding: utf-8 -*-
"""独立参考实现（交叉验证用）：仅做 NCM 解密，不写标签。

算法逐行移植自 PyPI ncmdump==0.1.1 的 ncmdump/core.py（BSD/MIT 原样逻辑），
用 PyCryptodome AES + ncmdump 的密钥流公式，与 lib/ncm.js 是两套独立实现。

用法： python ref_decrypt.py <input.ncm> <output_audio>
"""
import base64
import binascii
import json
import os
import struct
import sys

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad


def decrypt(input_path, output_path):
    core_key = binascii.a2b_hex('687A4852416D736F356B496E62617857')
    meta_key = binascii.a2b_hex('2331346C6A6B5F215C5D2630553C2728')

    f = open(input_path, 'rb')
    assert f.read(8) == b'CTENFDAM'
    f.seek(2, 1)

    key_length = struct.unpack('<I', f.read(4))[0]
    key_data = bytes(bytearray([b ^ 0x64 for b in f.read(key_length)]))
    key_data = unpad(AES.new(core_key, AES.MODE_ECB).decrypt(key_data), 16)[17:]
    key = bytearray(key_data)

    S = bytearray(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i % len(key)]) & 0xFF
        S[i], S[j] = S[j], S[i]

    meta_length = struct.unpack('<I', f.read(4))[0]
    meta_data = None
    if meta_length:
        raw = bytes(bytearray([b ^ 0x63 for b in f.read(meta_length)]))
        identifier = raw.decode('utf-8')
        meta_data = json.loads(
            unpad(AES.new(meta_key, AES.MODE_ECB).decrypt(base64.b64decode(raw[22:])), 16).decode('utf-8')[6:]
        )

    f.seek(5, 1)
    image_space = struct.unpack('<I', f.read(4))[0]
    image_size = struct.unpack('<I', f.read(4))[0]
    image_data = f.read(image_size) if image_size else None
    f.seek(image_space - image_size, 1)

    data = f.read()
    f.close()

    stream = bytes(bytearray([S[(S[i] + S[(i + S[i]) & 0xFF]) & 0xFF] for i in range(256)]))
    stream = bytes(bytearray(stream * (len(data) // 256 + 1))[1:1 + len(data)])
    data = bytes(bytearray([data[i] ^ stream[i] for i in range(len(data))]))

    with open(output_path, 'wb') as out:
        out.write(data)
    return meta_data, image_data, len(data)


if __name__ == '__main__':
    meta, image, size = decrypt(sys.argv[1], sys.argv[2])
    print(json.dumps({'output': sys.argv[2], 'size': size,
                      'format': (meta or {}).get('format'),
                      'musicName': (meta or {}).get('musicName'),
                      'coverSize': len(image) if image else 0}, ensure_ascii=False))
