import json
import httpx
import pytest
from fastapi.testclient import TestClient
from backend import app as module

HEADERS={'X-IP-Presenter':'1'}
CONTEXT={'name':'测试','slides':[{'id':'a','title':'总览','regions':[]},{'id':'b','title':'图表','regions':[{'id':'r','name':'图表'}]}], 'knowledge':[{'id':'k','title':'理由','text':'作者确认的理由','kind':'decision','source':'作者材料','slideId':'b','regionId':'r'}], 'view':{'main':{'imageId':'a','scale':1,'x':0,'y':0},'secondary':None},'history':[]}
@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ('OPENAI_API_KEY','LLM_API_KEY','TTS_API_KEY','ASR_API_KEY','LLM_MODEL','IP_PRESENTER_LOCAL'):
        monkeypatch.delenv(key,raising=False)
@pytest.fixture
def client():
    with TestClient(module.app) as c: yield c

def configured(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY','unit-test-key')
    monkeypatch.setenv('LLM_MODEL','test-model')

def mock_client(monkeypatch,handler):
    transport=httpx.MockTransport(handler)
    monkeypatch.setattr(module,'new_client',lambda:httpx.AsyncClient(transport=transport))

def body(question='为什么选择这个图表？'):
    return {'question':question,'context':CONTEXT,'allow_outside':False}

def packets(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]

def stream_text(parts):
    return ''.join('data: '+json.dumps({'choices':[{'delta':{'content':x}}]},ensure_ascii=False)+'\n\n' for x in parts)+'data: [DONE]\n\n'

def test_health_does_not_expose_key(client):
    data=client.get('/api/health').json();assert not data['llm'];assert 'key' not in json.dumps(data)
def test_missing_key_is_not_silently_mocked(client):
    assert client.post('/api/ask',json=body(),headers=HEADERS).status_code==503
def test_cross_origin_blocked(client):
    assert client.post('/api/ask',json=body(),headers={**HEADERS,'Origin':'https://evil.example'}).status_code==403
def test_missing_custom_header_blocked(client):
    assert client.post('/api/ask',json=body()).status_code==403
def test_env_not_served(client):
    assert client.get('/.env').status_code==404
def test_request_size_guard(client):
    assert client.post('/api/ask',content='{}',headers={**HEADERS,'Content-Type':'application/json','Content-Length':'999999999'}).status_code==413
def test_plan_validates_references():
    c=module.Context.model_validate(CONTEXT)
    p=module.validate_plan({'kind':'project','sources':['k'],'actions':[{'type':'focus_region','imageId':'b','regionId':'r'}]},c)
    assert p.actions[0].regionId=='r'
def test_plan_rejects_unknown_action():
    with pytest.raises(ValueError):module.validate_plan({'kind':'project','sources':['k'],'actions':[{'type':'shell','command':'x'}]},module.Context.model_validate(CONTEXT))
def test_plan_rejects_fake_citation():
    with pytest.raises(ValueError):module.validate_plan({'kind':'project','sources':['invented'],'actions':[]},module.Context.model_validate(CONTEXT))
def test_live_adapter_streams_only_after_valid_header(client,monkeypatch):
    configured(monkeypatch)
    text=stream_text(['{"kind":"project","sources":["k"],"actions":[{"type":"focus_region","imageId":"b",','"regionId":"r"}]}\n','依据作者材料。','没有虚构数据。'])
    mock_client(monkeypatch,lambda req:httpx.Response(200,text=text))
    ps=packets(client.post('/api/ask',json=body(),headers=HEADERS))
    assert ps[0]['type']=='meta';assert ps[0]['actions'][0]['regionId']=='r';assert ''.join(p.get('text','') for p in ps)=='依据作者材料。没有虚构数据。'
def test_malformed_header_fails_without_text_or_action(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,text=stream_text(['不是JSON\n这个不应播出。'])))
    ps=packets(client.post('/api/ask',json=body(),headers=HEADERS));assert [p['type'] for p in ps]==['error']
def test_no_evidence_forces_boundary_answer(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,text=stream_text(['{"kind":"project","sources":[],"actions":[]}\n虚构测试成功。'])))
    text=client.post('/api/ask',json=body(),headers=HEADERS).text;assert '虚构测试成功' not in text;assert '不足以支持' in text
def test_outside_answer_respects_switch(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,text=stream_text(['{"kind":"outside","sources":[],"actions":[]}\n不应出现的项目外答案'])))
    text=client.post('/api/ask',json=body(),headers=HEADERS).text;assert '不应出现' not in text;assert '当前项目讲解范围' in text
def test_upstream_error_is_explicit(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(401,json={'error':'nope'}))
    ps=packets(client.post('/api/ask',json=body(),headers=HEADERS));assert ps[0]['type']=='error';assert '401' in ps[0]['message']
def test_pcm_bytes_pass_through_and_voice_is_server_controlled(client,monkeypatch):
    configured(monkeypatch);seen=[]
    def handler(req):seen.append(json.loads(req.content));return httpx.Response(200,content=b'\0\0\1\0')
    mock_client(monkeypatch,handler)
    r=client.post('/api/tts',json={'text':'你好'},headers=HEADERS);assert r.content==b'\0\0\1\0';assert r.headers['content-type']=='audio/pcm';assert seen[0]['response_format']=='pcm';assert seen[0]['voice']=='coral'
def test_client_cannot_override_voice_or_key(client,monkeypatch):
    configured(monkeypatch);assert client.post('/api/tts',json={'text':'你好','voice':'other','key':'stolen'},headers=HEADERS).status_code==422
def test_transcription_accepts_browser_audio_without_persisting(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,json={'text':'放大图表'}))
    r=client.post('/api/transcribe',content=b'0'*100,headers={**HEADERS,'Content-Type':'audio/webm;codecs=opus'});assert r.json()['text']=='放大图表'
def test_invalid_audio_format_rejected(client,monkeypatch):
    configured(monkeypatch);assert client.post('/api/transcribe',content=b'0'*100,headers={**HEADERS,'Content-Type':'text/plain'}).status_code==415

def dialogue_body(text='也说说颜色'):
    return {'text':text,'questions':[{'id':1,'text':'为什么选图表','status':'paused'}],'active_id':1,'awaiting':'','view':{}}

def test_dialogue_requires_configuration(client):
    assert client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS).status_code==503

def test_dialogue_returns_validated_supplement(client,monkeypatch):
    configured(monkeypatch);seen=[]
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'intent':'supplement','target_id':1})}}]})
    mock_client(monkeypatch,handler)
    r=client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS)
    assert r.status_code==200;assert r.json()['target_id']==1;assert seen[0]['stream'] is False

def test_dialogue_rejects_nonexistent_target(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,json={'choices':[{'message':{'content':'{"intent":"select","target_id":99}'}}]}))
    assert client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS).status_code==502

def test_dialogue_rejects_arbitrary_operation(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,json={'choices':[{'message':{'content':'{"intent":"execute","code":"bad"}'}}]}))
    assert client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS).status_code==502

def test_dialogue_uncertain_plan_can_request_spoken_clarification(client,monkeypatch):
    configured(monkeypatch);plan={'intent':'clarify','clarification':'请说先讨论哪一个问题？'}
    mock_client(monkeypatch,lambda req:httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(plan)}}]}))
    assert client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS).json()['intent']=='clarify'

def test_dialogue_cannot_rewrite_completed_question(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,json={'choices':[{'message':{'content':'{"intent":"correction","target_id":1}'}}]}))
    body=dialogue_body();body['questions'][0]['status']='done'
    assert client.post('/api/dialogue',json=body,headers=HEADERS).status_code==502

def test_dialogue_error_never_silently_becomes_new_question(client,monkeypatch):
    configured(monkeypatch);mock_client(monkeypatch,lambda req:httpx.Response(200,json={'choices':[]}))
    r=client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS);assert r.status_code==502;assert '没有执行' in r.json()['detail']

def test_local_model_really_uses_ollama_without_cloud_key(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1');seen=[]
    def handler(req):
        seen.append(req)
        parts=['{"kind":"project","sources":["k"],"actions":[]}\n','依据作者确认的材料。']
        return httpx.Response(200,text='\n'.join(json.dumps({'message':{'content':x}},ensure_ascii=False) for x in parts))
    mock_client(monkeypatch,handler)
    ps=packets(client.post('/api/ask',json=body(),headers=HEADERS))
    assert ps[0]['type']=='meta' and ps[-1]['type']=='done'
    assert str(seen[0].url)=='http://127.0.0.1:11435/api/chat'
    assert 'authorization' not in seen[0].headers
    assert json.loads(seen[0].content)['model']=='qwen3:4b-instruct-2507-q4_K_M'

def test_local_model_disconnect_does_not_fall_back_to_cloud(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1');seen=[]
    def handler(req):
        seen.append(str(req.url));raise httpx.ConnectError('offline')
    mock_client(monkeypatch,handler)
    ps=packets(client.post('/api/ask',json=body(),headers=HEADERS))
    assert ps[0]['type']=='error' and seen==['http://127.0.0.1:11435/api/chat']

def test_local_dialogue_is_validated(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1')
    mock_client(monkeypatch,lambda req:httpx.Response(200,json={'message':{'content':'{"intent":"select","target_id":99}'}}))
    assert client.post('/api/dialogue',json=dialogue_body(),headers=HEADERS).status_code==502

def test_local_pcm_uses_native_speech(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1')
    async def synthesize(text):assert text=='你好';return b'\1\0'*50
    monkeypatch.setattr(module.local_services,'synthesize',synthesize)
    r=client.post('/api/tts',json={'text':'你好'},headers=HEADERS)
    assert r.status_code==200 and r.content==b'\1\0'*50

def test_local_transcription_rejects_non_wave_before_upload(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1')
    assert client.post('/api/transcribe',content=b'0'*100,headers={**HEADERS,'Content-Type':'audio/webm'}).status_code==415

def test_local_transcription_validates_wave_and_uses_loopback(client,monkeypatch):
    import io,wave
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1');seen=[]
    def handler(req):seen.append(req);return httpx.Response(200,json={'text':'開始匯報\n'})
    mock_client(monkeypatch,handler)
    buffer=io.BytesIO()
    with wave.open(buffer,'wb') as audio:
        audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(b'\0\x10\0\xf0'*8000)
    r=client.post('/api/transcribe',content=buffer.getvalue(),headers={**HEADERS,'Content-Type':'audio/wav'})
    assert r.json()['text']=='开始汇报' and str(seen[0].url)=='http://127.0.0.1:8178/inference'
    assert 'authorization' not in seen[0].headers

def test_stable_project_prefix_precedes_changing_question(client,monkeypatch):
    configured(monkeypatch);seen=[]
    def handler(req):
        seen.append(json.loads(req.content)['messages'][1]['content'])
        return httpx.Response(200,text=stream_text(['{"kind":"unknown","sources":[],"actions":[]}\n材料不足。']))
    mock_client(monkeypatch,handler)
    for q in ('第一问','第二问'):client.post('/api/ask',json=body(q),headers=HEADERS)
    assert seen[0].split('"question":')[0]==seen[1].split('"question":')[0]
    assert json.loads(seen[1])['question']=='第二问'

def test_digital_silence_never_reaches_recognizer(client,monkeypatch):
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1')
    def unexpected(req):raise AssertionError('silence must not produce a vocabulary hallucination')
    mock_client(monkeypatch,unexpected)
    for pcm in (bytes(48000), b'\0\x01'*24000):
        r=client.post('/api/transcribe',content=module.local_services.pcm_to_wave(pcm),headers={**HEADERS,'Content-Type':'audio/wav'})
        assert r.status_code==200 and r.json()=={'text':'','empty':True}

def test_project_vocabulary_is_bounded_and_forwarded_to_local_asr(client,monkeypatch):
    from urllib.parse import quote
    monkeypatch.setenv('IP_PRESENTER_LOCAL','1');seen=[]
    def handler(req):seen.append(req.content.decode('utf-8',errors='replace'));return httpx.Response(200,json={'text':'示例图表'})
    mock_client(monkeypatch,handler)
    audio=module.local_services.pcm_to_wave(b'\0\x10\0\xf0'*12000)
    headers={**HEADERS,'Content-Type':'audio/wav','X-IP-ASR-Vocabulary':quote(json.dumps(['示例图表','示例插图'],ensure_ascii=False))}
    assert client.post('/api/transcribe',content=audio,headers=headers).json()['text']=='示例图表'
    assert '数据图表，标题，示例图表，示例插图。' in seen[0]
    assert 'name="beam_size"\r\n\r\n1' in seen[0]
    for value in ({'instruction':'bad'},['非法\n名称'],['x'*25],['a']*41):
        headers['X-IP-ASR-Vocabulary']=quote(json.dumps(value))
        assert client.post('/api/transcribe',content=audio,headers=headers).status_code==400
    assert len(seen)==1

def test_card_kind_alias_preserves_citation_and_action_validation():
    c=module.Context.model_validate(CONTEXT)
    assert module.validate_plan({'kind':'fact','sources':['k'],'actions':[]},c).kind=='project'
    assert module.validate_plan({'kind':'hypothesis','sources':['k'],'actions':[]},c).kind=='extension'
    with pytest.raises(ValueError):module.validate_plan({'kind':'fact','sources':['fake'],'actions':[]},c)
    with pytest.raises(ValueError):module.validate_plan({'kind':'fact','sources':['k'],'actions':[{'type':'execute'}]},c)

def test_ambiguous_pointer_never_reaches_model_or_moves_picture(client,monkeypatch):
    configured(monkeypatch)
    def unexpected(req):raise AssertionError('ambiguous pointing must be clarified locally')
    mock_client(monkeypatch,unexpected)
    result=packets(client.post('/api/ask',json=body('把那个放大一下。'),headers=HEADERS))
    assert result[0]['actions']==[];assert '哪个表情' in result[1]['text']

def test_two_cross_page_focuses_stay_visible_together():
    c=module.Context.model_validate(CONTEXT)
    c.slides[0].regions=[module.Region(id='r1',name='区域一')]
    p=module.validate_plan({'kind':'project','sources':['k'],'actions':[{'type':'focus_region','imageId':'a','regionId':'r1'},{'type':'focus_region','imageId':'b','regionId':'r'}]},c)
    assert len(p.actions)==1 and p.actions[0].type=='compare' and p.actions[0].imageIds==['a','b']

def test_invalid_source_retries_once_before_any_public_output(client,monkeypatch):
    configured(monkeypatch);calls=[]
    def handler(req):
        calls.append(json.loads(req.content))
        text='{"kind":"project","sources":["not-a-card"],"actions":[]}\n错误引用不得播出。' if len(calls)==1 else '{"kind":"project","sources":["k"],"actions":[]}\n依据现有材料。'
        return httpx.Response(200,text=stream_text([text]))
    mock_client(monkeypatch,handler)
    result=packets(client.post('/api/ask',json=body(),headers=HEADERS))
    assert len(calls)==2
    assert [x['type'] for x in result]==['meta','text','done']
    assert result[0]['sources']==['k'] and '错误引用' not in str(result)

def test_invalid_plan_retry_is_bounded(client,monkeypatch):
    configured(monkeypatch);calls=[]
    def handler(req):
        calls.append(req)
        return httpx.Response(200,text=stream_text(['{"kind":"project","sources":["fake"],"actions":[]}\n不能播出。']))
    mock_client(monkeypatch,handler)
    result=packets(client.post('/api/ask',json=body(),headers=HEADERS))
    assert len(calls)==2 and [x['type'] for x in result]==['error']
