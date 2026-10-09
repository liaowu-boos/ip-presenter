import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import app
from backend import performance_recordings as store


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.patch=patch.object(store,'RECORDINGS',self.root);self.patch.start()
        self.client=TestClient(app)
        # This tests byte persistence and guards, not video decodability.
        self.body=b'\x1a\x45\xdf\xa3'+bytes(range(256))*16
        self.sha=hashlib.sha256(self.body).hexdigest()
        self.headers={'X-IP-Presenter':'1','Origin':'http://testserver',
                      'Content-Type':'video/webm','X-Recording-SHA256':self.sha}
    def tearDown(self):
        self.client.close();self.patch.stop();self.temp.cleanup()
    def post(self,body=None,headers=None):
        return self.client.post('/api/performance-recordings',content=self.body if body is None else body,
                                headers=self.headers if headers is None else headers)
    def test_exact_bytes_and_idempotent_download(self):
        first=self.post();self.assertEqual(first.status_code,200)
        self.assertEqual(self.post().json(),first.json())
        path=self.root/(self.sha+'.webm');self.assertEqual(path.read_bytes(),self.body)
        got=self.client.get(first.json()['url']);self.assertEqual(got.content,self.body)
        self.assertEqual(got.headers['content-type'],'video/webm')
        self.assertEqual(len(list(self.root.iterdir())),1)
    def test_origin_header_type_hash_and_header_bytes_guard(self):
        for delta,status in [({'Origin':'https://example.org'},403),({'X-IP-Presenter':'0'},403),
                            ({'Content-Type':'text/html'},415),({'X-Recording-SHA256':'0'*64},400),
                            ({'X-Recording-SHA256':'../bad'},400)]:
            self.assertEqual(self.post(headers={**self.headers,**delta}).status_code,status)
        self.assertEqual(self.post(body=b'not-webm'*8).status_code,400)
        self.assertEqual(list(self.root.iterdir()),[])
    def test_stream_bound_and_corrupt_existing_file_do_not_overwrite(self):
        with patch.object(store,'MAX_RECORDING_BYTES',32):
            self.assertEqual(self.post().status_code,413)
        self.assertEqual(list(self.root.iterdir()),[])
        target=self.root/(self.sha+'.webm');target.write_bytes(b'keep-existing')
        self.assertEqual(self.post().status_code,409)
        self.assertEqual(target.read_bytes(),b'keep-existing')
        self.assertFalse(list(self.root.glob('.pending-*')))
    def test_download_rejects_missing_paths_and_symlinks(self):
        target=self.root/(self.sha+'.webm');target.symlink_to(self.root/'outside')
        (self.root/'outside').write_bytes(b'private')
        self.assertEqual(self.client.get('/api/performance-recordings/'+target.name).status_code,404)
        self.assertEqual(self.client.get('/api/performance-recordings/outside').status_code,404)


if __name__=='__main__':unittest.main()
