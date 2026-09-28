package main

import (
 "io"
 "net"
 "time"
)

// Long-running SSH and AI streams expire only when idle, not one minute after
// connection. Reads and writes each retain a bounded wait on broken peers.
type idleReader struct {conn net.Conn; reader io.Reader; timeout time.Duration}
func (r idleReader) Read(p []byte)(int,error){r.conn.SetReadDeadline(time.Now().Add(r.timeout));return r.reader.Read(p)}
type idleWriter struct {conn net.Conn; timeout time.Duration}
func (w idleWriter) Write(p []byte)(int,error){w.conn.SetWriteDeadline(time.Now().Add(w.timeout));return w.conn.Write(p)}
func proxyTunnel(client,remote net.Conn,buffered io.Reader,idle time.Duration){
 done:=make(chan struct{})
 go func(){io.Copy(idleWriter{remote,idle},idleReader{client,buffered,idle});remote.Close();client.Close();close(done)}()
 io.Copy(idleWriter{client,idle},idleReader{remote,remote,idle})
 client.Close();remote.Close();<-done
}
