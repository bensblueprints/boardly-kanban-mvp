package main

import (
 "context"
 "crypto/subtle"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "log"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "regexp"
 "strings"
 "sync"
 "time"
 "tailscale.com/tsnet"
)

type network struct {server *tsnet.Server; mu sync.Mutex; closing bool; sockets map[net.Conn]bool}
type service struct {mu sync.Mutex; nodes map[string]*network; root,token string}
var accountPattern=regexp.MustCompile(`^[a-f0-9]{64}$`)
func (s *service) node(id string,create bool)(*network,error){s.mu.Lock();defer s.mu.Unlock();if n:=s.nodes[id];n!=nil{return n,nil};if !create{return nil,errors.New("Tailscale is not connected")};if len(s.nodes)>=100{return nil,errors.New("Connector capacity reached")};dir:=filepath.Join(s.root,id);if err:=os.MkdirAll(dir,0700);err!=nil{return nil,err};srv:=&tsnet.Server{Dir:dir,Hostname:"boardly-"+id[:12],Logf:func(string,...any){},UserLogf:func(string,...any){}};if err:=srv.Start();err!=nil{return nil,err};n:=&network{server:srv,sockets:map[net.Conn]bool{}};s.nodes[id]=n;if err:=os.WriteFile(filepath.Join(dir,"boardly-enabled"),[]byte("1"),0600);err!=nil{return nil,err};return n,nil}
func respond(w http.ResponseWriter,code int,data any){w.Header().Set("Content-Type","application/json");w.Header().Set("Cache-Control","no-store");w.WriteHeader(code);json.NewEncoder(w).Encode(data)}
func (s *service) handle(w http.ResponseWriter,r *http.Request){
 if subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(r.Header.Get("Authorization"),"Bearer ")),[]byte(s.token))!=1{respond(w,401,map[string]string{"error":"Unauthorized"});return}
 parts:=strings.Split(strings.Trim(r.URL.Path,"/"),"/");if len(parts)!=3||parts[0]!="accounts"||!accountPattern.MatchString(parts[1]){respond(w,404,map[string]string{"error":"Not found"});return};id,action:=parts[1],parts[2]
 if action=="disconnect"&&r.Method=="POST"{s.mu.Lock();n:=s.nodes[id];delete(s.nodes,id);if n!=nil{n.mu.Lock();n.closing=true;for c:=range n.sockets{c.Close()};n.mu.Unlock();n.server.Close()};os.RemoveAll(filepath.Join(s.root,id));s.mu.Unlock();respond(w,200,map[string]bool{"ok":true});return}
 create:=action=="connect"&&r.Method=="POST";n,err:=s.node(id,create);if err!=nil{if action=="status"{respond(w,200,map[string]any{"state":"disconnected","devices":[]any{}})}else{respond(w,409,map[string]string{"error":err.Error()})};return}
 lc,err:=n.server.LocalClient();if err!=nil{respond(w,503,map[string]string{"error":"Connector is starting"});return}
 ctx,cancel:=context.WithTimeout(r.Context(),15*time.Second);defer cancel();status,err:=lc.Status(ctx);if err!=nil{respond(w,503,map[string]string{"error":"Unable to read Tailscale status"});return}
 if action=="status"||create{devices:=[]map[string]any{};for _,p:=range status.Peer{ips:=[]string{};for _,ip:=range p.TailscaleIPs{ips=append(ips,ip.String())};devices=append(devices,map[string]any{"id":string(p.ID),"name":p.HostName,"dns_name":strings.TrimSuffix(p.DNSName,"."),"addresses":ips,"online":p.Online,"os":p.OS})};url:=status.AuthURL;if !strings.HasPrefix(url,"https://login.tailscale.com/"){url=""};respond(w,200,map[string]any{"state":status.BackendState,"auth_url":url,"devices":devices,"device_name":"boardly-"+id[:12]});return}
 if action!="dial"||r.Method!="CONNECT"{respond(w,404,map[string]string{"error":"Not found"});return}
 // Resolve a stable peer identity inside this account's network. Never accept an arbitrary destination or subnet route.
 device:=r.Header.Get("X-Boardly-Device");port:=r.Header.Get("X-Boardly-Port");var portNumber int;if _,err=fmt.Sscanf(port,"%d",&portNumber);err!=nil||fmt.Sprint(portNumber)!=port||portNumber<1||portNumber>65535{respond(w,400,map[string]string{"error":"Invalid port"});return}
 destination:="";for _,p:=range status.Peer{if string(p.ID)==device&&len(p.TailscaleIPs)>0{destination=net.JoinHostPort(p.TailscaleIPs[0].String(),port);break}};if destination==""{respond(w,403,map[string]string{"error":"Device does not belong to this account network"});return}
 remote,err:=n.server.Dial(ctx,"tcp",destination);if err!=nil{respond(w,502,map[string]string{"error":"The device could not be reached"});return}
 n.mu.Lock();if n.closing{n.mu.Unlock();remote.Close();respond(w,409,map[string]string{"error":"Network disconnected"});return};n.sockets[remote]=true;n.mu.Unlock();defer func(){remote.Close();n.mu.Lock();delete(n.sockets,remote);n.mu.Unlock()}()
 client,rw,err:=w.(http.Hijacker).Hijack();if err!=nil{return};defer client.Close();client.SetDeadline(time.Now().Add(60*time.Second));remote.SetDeadline(time.Now().Add(60*time.Second));rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n");rw.Flush();done:=make(chan struct{});go func(){io.Copy(remote,rw);remote.Close();close(done)}();io.Copy(client,remote);client.Close();<-done
}
func main(){root:=os.Getenv("TAILNET_STATE_DIR");if root==""{root="/state"};tokenBytes,err:=os.ReadFile(os.Getenv("TAILNET_TOKEN_FILE"));if err!=nil||len(strings.TrimSpace(string(tokenBytes)))<32{log.Fatal("Private connector token is required")};s:=&service{root:root,token:strings.TrimSpace(string(tokenBytes)),nodes:map[string]*network{}};os.MkdirAll(root,0700);entries,_:=os.ReadDir(root);for _,e:=range entries{if e.IsDir()&&accountPattern.MatchString(e.Name()){if _,err:=os.Stat(filepath.Join(root,e.Name(),"boardly-enabled"));err==nil{if _,err:=s.node(e.Name(),true);err!=nil{log.Print("A saved connector could not start")}}}};server:=&http.Server{Addr:":5317",Handler:http.HandlerFunc(s.handle),ReadHeaderTimeout:10*time.Second};log.Fatal(server.ListenAndServe())}
