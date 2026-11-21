#define _WIN32_WINNT 0x0A00
#include <winsock2.h>

#include <aclapi.h>
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <objbase.h>
#include <sddl.h>
#include <string>
#include <thread>
#include <userenv.h>
#include <vector>
#include <windows.h>

using std::wstring;
void fail(const char *step) {
  std::fprintf(stderr, "Router startup failed at %s (%lu)\n", step,
               GetLastError());
  throw 1;
}
void allow(const wstring &path, PSID sid, DWORD rights, DWORD flags,
           ACCESS_MODE mode = GRANT_ACCESS) {
  PACL old = nullptr, next = nullptr;
  PSECURITY_DESCRIPTOR desc = nullptr;
  DWORD r = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION, nullptr, nullptr,
                                  &old, nullptr, &desc);
  if (r) {
    SetLastError(r);
    fail("read test ACL");
  }
  EXPLICIT_ACCESSW e{};
  e.grfAccessPermissions = rights;
  e.grfAccessMode = mode;
  e.grfInheritance = flags;
  e.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  e.Trustee.ptstrName = (LPWSTR)sid;
  r = SetEntriesInAclW(1, &e, old, &next);
  if (!r)
    r = SetNamedSecurityInfoW((LPWSTR)path.c_str(), SE_FILE_OBJECT,
                              DACL_SECURITY_INFORMATION, nullptr, nullptr, next,
                              nullptr);
  if (r) {
    SetLastError(r);
    fail("set test ACL");
  }
  LocalFree(next);
  LocalFree(desc);
}
void low(const wstring &path) {
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &sd, nullptr))
    fail("low label");
  PACL acl = nullptr;
  BOOL exists, def;
  GetSecurityDescriptorSacl(sd, &exists, &acl, &def);
  DWORD r = SetNamedSecurityInfoW((LPWSTR)path.c_str(), SE_FILE_OBJECT,
                                  LABEL_SECURITY_INFORMATION, nullptr, nullptr,
                                  nullptr, acl);
  LocalFree(sd);
  if (r) {
    SetLastError(r);
    fail("set integrity");
  }
}
bool sendAll(SOCKET s, const char *p, int len) {
  while (len > 0) {
    int n = send(s, p, len, 0);
    if (n <= 0)
      return false;
    p += n;
    len -= n;
  }
  return true;
}
bool exchangePipe(HANDLE pipe, void *buffer, DWORD length, DWORD *count,
                  bool writing) {
  OVERLAPPED op{};
  op.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!op.hEvent)
    return false;
  BOOL ok = writing ? WriteFile(pipe, buffer, length, count, &op)
                    : ReadFile(pipe, buffer, length, count, &op);
  if (!ok && GetLastError() == ERROR_IO_PENDING)
    ok = GetOverlappedResult(pipe, &op, count, TRUE);
  CloseHandle(op.hEvent);
  return ok;
}
void relay(HANDLE pipe, unsigned short port) {
  SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  sockaddr_in proxy{};
  proxy.sin_family = AF_INET;
  proxy.sin_port = htons(port);
  proxy.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  const char req[] =
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n";
  std::string reply;
  bool connected = sock != INVALID_SOCKET &&
                   connect(sock, (sockaddr *)&proxy, sizeof(proxy)) == 0 &&
                   sendAll(sock, req, sizeof(req) - 1);
  while (connected && reply.size() < 4096 && !reply.ends_with("\r\n\r\n")) {
    char c;
    if (recv(sock, &c, 1, 0) != 1) {
      connected = false;
      break;
    }
    reply += c;
  }
  if (connected && reply.starts_with("HTTP/1.") &&
      reply.substr(8, 4) == " 200") {
    std::thread up([=]() {
      char buf[16384];
      DWORD n;
      while (exchangePipe(pipe, buf, sizeof(buf), &n, false) && n &&
             sendAll(sock, buf, n)) {
      }
      shutdown(sock, SD_SEND);
    });
    char buf[16384];
    int n;
    DWORD written;
    while ((n = recv(sock, buf, sizeof(buf), 0)) > 0 &&
           exchangePipe(pipe, buf, n, &written, true) && written == (DWORD)n) {
    }
    CancelIoEx(pipe, nullptr);
    DisconnectNamedPipe(pipe);
    shutdown(sock, SD_BOTH);
    up.join();
  }
  closesocket(sock);
  CloseHandle(pipe);
}

static bool makePair(HANDLE &server, HANDLE &client, bool asyncClient) {
  GUID id{};
  if (FAILED(CoCreateGuid(&id)))
    return false;
  wchar_t tag[40];
  StringFromGUID2(id, tag, 40);
  wstring name = L"\\\\.\\pipe\\zcodex-private-" + wstring(tag);
  server = CreateNamedPipeW(name.c_str(),
                            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE |
                                (asyncClient ? FILE_FLAG_OVERLAPPED : 0),
                            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                                PIPE_REJECT_REMOTE_CLIENTS,
                            1, 65536, 65536, 0, nullptr);
  if (server == INVALID_HANDLE_VALUE)
    return false;
  client = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                       OPEN_EXISTING,
                       SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION |
                           (asyncClient ? FILE_FLAG_OVERLAPPED : 0),
                       nullptr);
  if (client == INVALID_HANDLE_VALUE) {
    CloseHandle(server);
    return false;
  }
  OVERLAPPED connection{};
  if (!ConnectNamedPipe(server, asyncClient ? &connection : nullptr) &&
      GetLastError() != ERROR_PIPE_CONNECTED) {
    CloseHandle(server);
    CloseHandle(client);
    return false;
  }
  return true;
}
void broker(HANDLE control, HANDLE process, unsigned short port) {
  unsigned char request;
  DWORD count;
  while (ReadFile(control, &request, 1, &count, nullptr) && count == 1 &&
         request == 1) {
    HANDLE server = nullptr, client = nullptr, remote = nullptr;
    if (!makePair(server, client, true))
      break;
    BOOL ok = DuplicateHandle(GetCurrentProcess(), client, process, &remote, 0,
                              FALSE, DUPLICATE_SAME_ACCESS);
    CloseHandle(client);
    if (!ok) {
      CloseHandle(server);
      break;
    }
    uint64_t value = (uintptr_t)remote;
    if (!WriteFile(control, &value, 8, &count, nullptr) || count != 8) {
      CloseHandle(server);
      break;
    }
    std::thread(relay, server, port).detach();
  }
  CloseHandle(control);
}

int run(int argc, wchar_t **argv) {
  if (argc != 2)
    return 64;
  wchar_t exe[MAX_PATH];
  if (!GetModuleFileNameW(nullptr, exe, MAX_PATH))
    fail("launcher path");
  wstring assets = exe;
  assets.resize(assets.find_last_of(L"\\/"));
  const wstring binary = assets + L"\\router-core.exe", data = argv[1],
                cwd = data + L"\\workspace", home = data + L"\\codex-home",
                temp = data + L"\\temp";
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid)))
    fail("guid");
  wchar_t id[42];
  StringFromGUID2(guid, id, 42);
  const wstring tag(id + 1, 36);
  const wstring profile = L"zcodex.webprobe." + tag,
                pipeName = L"\\\\.\\pipe\\LOCAL\\zcodex-web-" + tag;
  PSID sid = nullptr;
  if (FAILED(CreateAppContainerProfile(profile.c_str(),
                                       L"Temporary Router web acceptance",
                                       L"Isolated test", nullptr, 0, &sid)))
    fail("profile");
  struct Cleanup {
    wstring name;
    ~Cleanup() { DeleteAppContainerProfile(name.c_str()); }
  } cleanup{profile};
  const DWORD kids = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  allow(binary, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, 0);
  if (!CreateDirectoryW(temp.c_str(), nullptr) &&
      GetLastError() != ERROR_ALREADY_EXISTS)
    fail("temp");
  allow(home, sid,
        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE,
        kids);
  allow(home + L"\\config.toml", sid,
        FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
            FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER,
        0, DENY_ACCESS);
  allow(temp, sid,
        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE,
        kids);
  allow(cwd, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, 0);
  allow(data + L"\\home", sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, 0);
  low(home);
  low(temp);
  std::filesystem::create_directories(temp + L"\\Packages\\" + profile +
                                      L"\\AC\\Temp");
  WSADATA winsock;
  WSAStartup(MAKEWORD(2, 2), &winsock);
  FILE *settings = _wfopen((assets + L"\\\\proxy-port.txt").c_str(), L"r");
  unsigned port = 0;
  if (!settings || fscanf(settings, "%u", &port) != 1 || !port || port > 65535)
    fail("test proxy configuration");
  fclose(settings);
  HANDLE control = nullptr, clientControl = nullptr;
  if (!makePair(control, clientControl, false) ||
      !SetHandleInformation(clientControl, HANDLE_FLAG_INHERIT,
                            HANDLE_FLAG_INHERIT))
    fail("private control");
  SECURITY_CAPABILITIES caps{};
  caps.AppContainerSid = sid;
  typedef BOOL(WINAPI * DeriveFn)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
  auto derive = (DeriveFn)GetProcAddress(GetModuleHandleW(L"kernelbase.dll"),
                                         "DeriveCapabilitySidsFromName");
  PSID *groups = nullptr, *ids = nullptr;
  DWORD ng = 0, ni = 0;
  if (!derive || !derive(L"registryRead", &groups, &ng, &ids, &ni) || !ni)
    fail("system registry capability");
  std::vector<SID_AND_ATTRIBUTES> attributes;
  for (DWORD i = 0; i < ni; i++)
    attributes.push_back({ids[i], SE_GROUP_ENABLED});
  caps.Capabilities = attributes.data();
  caps.CapabilityCount = (DWORD)attributes.size();

  DWORD opt = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  HANDLE io[4];
  io[3] = clientControl;
  DWORD which[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; i++)
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(which[i]),
                         GetCurrentProcess(), &io[i], 0, TRUE,
                         DUPLICATE_SAME_ACCESS))
      fail("duplicate stdio");
  SIZE_T length = 0;
  InitializeProcThreadAttributeList(nullptr, 3, 0, &length);
  std::vector<char> buf(length);
  STARTUPINFOEXW start{};
  start.StartupInfo.cb = sizeof(start);
  start.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)buf.data();
  if (!InitializeProcThreadAttributeList(start.lpAttributeList, 3, 0,
                                         &length) ||
      !UpdateProcThreadAttribute(start.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                 &caps, sizeof(caps), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(
          start.lpAttributeList, 0,
          PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &opt,
          sizeof(opt), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(start.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST, io,
                                 sizeof(io), nullptr, nullptr))
    fail("launch attributes");
  start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  start.StartupInfo.hStdInput = io[0];
  start.StartupInfo.hStdOutput = io[1];
  start.StartupInfo.hStdError = io[2];
  wchar_t windir[MAX_PATH];
  GetWindowsDirectoryW(windir, MAX_PATH);
  wchar_t profileFolder[MAX_PATH];
  LPWSTR profilePath = nullptr;
  LPWSTR sidText = nullptr;
  ConvertSidToStringSidW(sid, &sidText);
  GetAppContainerFolderPath(sidText, &profilePath);
  LocalFree(sidText);
  std::vector<wstring> vars = {L"CODEX_HOME=" + home,
                               L"HOME=" + data + L"\\home",
                               L"USERPROFILE=" + data + L"\\home",
                               L"LOCALAPPDATA=" + temp,
                               L"APPDATA=" + temp,
                               L"SystemRoot=" + wstring(windir),
                               L"WINDIR=" + wstring(windir),
                               L"TEMP=" + temp,
                               L"TMP=" + temp,
                               L"ZCODEX_ROUTER_TLS_PIPE=zcodex-inherited-tls",
                               L"ZCODEX_CONTROL=" +
                                   std::to_wstring((uintptr_t)clientControl)};
  HANDLE identity =
      CreateFileW(home.c_str(), FILE_READ_ATTRIBUTES,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                  nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  wchar_t finalNt[32768];
  DWORD ntlen =
      identity == INVALID_HANDLE_VALUE
          ? 0
          : GetFinalPathNameByHandleW(identity, finalNt, 32768, VOLUME_NAME_NT);
  if (!ntlen || ntlen >= 32768)
    fail("router directory identity");
  CloseHandle(identity);
  vars.push_back(L"ZCODEX_HOME_NT=" + wstring(finalNt, ntlen));

  std::sort(vars.begin(), vars.end());
  std::vector<wchar_t> env;
  for (auto &v : vars) {
    env.insert(env.end(), v.begin(), v.end());
    env.push_back(0);
  }
  env.push_back(0);
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.ActiveProcessLimit = 1;
  info.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                       &info, sizeof(info)))
    fail("job");
  PROCESS_INFORMATION child{};
  wstring command = L"\"" + binary + L"\" --listen stdio:// --strict-config";
  if (!CreateProcessW(binary.c_str(), command.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                          CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                      env.data(), cwd.c_str(), &start.StartupInfo, &child)) {
    DWORD e = GetLastError();
    fprintf(stderr, "Router LPAC CreateProcess returned %lu\n", e);
    return 2;
  }
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    TerminateProcess(child.hProcess, 2);
    return 3;
  }
  std::thread(broker, control, child.hProcess, (unsigned short)port).detach();
  ResumeThread(child.hThread);
  CloseHandle(child.hThread);
  for (auto h : io)
    CloseHandle(h);
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD rc = 1;
  GetExitCodeProcess(child.hProcess, &rc);
  CloseHandle(child.hProcess);
  CloseHandle(job);
  allow(binary, sid, 0, 0, REVOKE_ACCESS);
  if (profilePath)
    CoTaskMemFree(profilePath);
  FreeSid(sid);
  DeleteProcThreadAttributeList(start.lpAttributeList);
  return (int)rc;
}

int wmain(int argc, wchar_t **argv) {
  try {
    return run(argc, argv);
  } catch (...) {
    return 1;
  }
}