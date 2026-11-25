"""Linux DAC fixture for a pre-existing Worker account and two service identities."""
import hashlib
import json
import os
import pathlib
import socket
import struct
import tempfile

# Numeric fixture credentials only. This does not create users or edit group databases.
WORKER, CONTROL, ROUTER = 62101, 62102, 62103


def as_identity(uid, action, keep=()):
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(reader)
        try:
            for entry in os.listdir('/proc/self/fd'):
                fd = int(entry)
                if fd > 2 and fd != writer and fd not in keep:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            data = json.dumps(action()).encode()
            os.write(writer, data)
        except BaseException:
            os._exit(1)
        os._exit(0)
    os.close(writer)
    with os.fdopen(reader) as pipe:
        result = pipe.read()
    assert os.waitpid(pid, 0)[1] == 0
    return json.loads(result)


def private_dir(path, uid):
    path.mkdir(mode=0o700)
    os.chown(str(path), uid, uid)


def marker(path, uid):
    path.write_text('synthetic-' + path.name)
    path.chmod(0o600)
    os.chown(str(path), uid, uid)


def probe(paths):
    return {name: {'read': os.access(str(path), os.R_OK), 'write': os.access(str(path), os.W_OK)}
            for name, path in paths.items()}


def run(base):
    # Build the old user's home first. No owner, mode or location changes at enrollment.
    base.chmod(0o711)
    worker = base / 'existing-worker'
    private_dir(worker, WORKER)
    history = worker / 'history-marker'
    marker(history, WORKER)

    def fingerprint():
        st = history.stat()
        return [st.st_dev, st.st_ino, st.st_uid, st.st_mode,
                hashlib.sha256(history.read_bytes()).hexdigest()]

    before = fingerprint()
    control, router = base / 'control', base / 'router'
    private_dir(control, CONTROL)
    private_dir(router, ROUTER)
    state, auth = control / 'private-state', router / 'credential-marker'
    marker(state, CONTROL)
    marker(auth, ROUTER)
    installation = base / 'release'
    installation.mkdir(mode=0o755)
    artifact = installation / 'codex-marker'
    artifact.write_text('synthetic official executable ownership marker')
    artifact.chmod(0o555)

    # Administrator-owned endpoint directory with a Worker-owned listener. The Worker
    # can trade the returned task data but cannot replace the socket pathname.
    endpoint = base / 'worker-bridge'
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(endpoint))
        listener.listen(2)
        os.chown(str(endpoint), WORKER, CONTROL)
        endpoint.chmod(0o660)

        def connect():
            with socket.socket(socket.AF_UNIX) as client:
                try:
                    client.connect(str(endpoint))
                    return 'connected'
                except PermissionError:
                    return 'denied'
        assert as_identity(CONTROL, connect) == 'connected'
        def accept_control():
            conn, _ = listener.accept()
            with conn:
                _, peer, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                return peer

        assert as_identity(WORKER, accept_control, keep=(listener.fileno(),)) == CONTROL
        assert as_identity(ROUTER, connect) == 'denied'

    paths = {'workerHistory': history, 'controlState': state, 'routerCredential': auth,
             'binary': artifact, 'installDirectory': installation, 'ipcParent': base}
    result = {name: as_identity(uid, lambda: probe(paths)) for name, uid in
              [('worker', WORKER), ('control', CONTROL), ('router', ROUTER)]}
    for role, own in [('worker', 'workerHistory'), ('control', 'controlState'), ('router', 'routerCredential')]:
        for label in ['workerHistory', 'controlState', 'routerCredential']:
            assert result[role][label] == {'read': label == own, 'write': label == own}
        for label in ['binary', 'installDirectory', 'ipcParent']:
            assert not result[role][label]['write']
    assert fingerprint() == before
    return {'platform': 'linux', 'machine': os.uname().machine, 'evidence': 'DAC fixtures only',
            'matrix': result, 'originalWorkerMarkerInodeOwnerModeDigestUnchanged': True,
            'controlPeerUidVerified': True, 'routerSocketConnectDenied': True}


if __name__ == '__main__':
    assert os.geteuid() == 0, 'requires fixture uid switching on Linux'
    with tempfile.TemporaryDirectory(prefix='zcodex-r3-identity-', dir='/var/tmp') as temp:
        print(json.dumps(run(pathlib.Path(temp)), indent=2))
