package main

import (
 "bufio"
 "bytes"
 "io"
 "net"
 "testing"
 "time"
)

func tunnelFixture(idle time.Duration)(net.Conn,net.Conn,<-chan struct{}){
 app,client:=net.Pipe();remote,peer:=net.Pipe();done:=make(chan struct{})
 go func(){proxyTunnel(client,remote,bufio.NewReader(client),idle);close(done)}()
 return app,peer,done
}
func TestActiveTunnelOutlivesInitialDeadline(t *testing.T){
 app,peer,done:=tunnelFixture(150*time.Millisecond);defer app.Close();defer peer.Close()
 go func(){io.Copy(peer,peer)}()
 for i:=0;i<12;i++{if _,err:=app.Write([]byte("alive"));err!=nil{t.Fatal(err)};b:=make([]byte,5);if _,err:=io.ReadFull(app,b);err!=nil{t.Fatal(err)};if string(b)!="alive"{t.Fatal("corrupted stream")};time.Sleep(30*time.Millisecond)}
 app.Close();select{case <-done:case <-time.After(time.Second):t.Fatal("closed client left tunnel running")}
}
func TestIdleAndRevokedTunnelsClose(t *testing.T){
 for _,revoke:=range []bool{false,true}{app,peer,done:=tunnelFixture(50*time.Millisecond);if revoke{peer.Close()};select{case <-done:case <-time.After(time.Second):t.Fatal("idle/revoked tunnel did not stop")};app.Close();peer.Close()}
}
func TestLargeBidirectionalTransfer(t *testing.T){
 app,peer,done:=tunnelFixture(time.Second);defer app.Close();defer peer.Close()
 payload:=bytes.Repeat([]byte("image-frame"),300000)
 go func(){io.Copy(peer,peer)}()
 written:=make(chan error,1);go func(){_,err:=app.Write(payload);written<-err}()
 got:=make([]byte,len(payload));if _,err:=io.ReadFull(app,got);err!=nil{t.Fatal(err)};if err:=<-written;err!=nil{t.Fatal(err)};if !bytes.Equal(got,payload){t.Fatal("large payload changed")}
 app.Close();select{case <-done:case <-time.After(time.Second):t.Fatal("tunnel did not finish")}
}
