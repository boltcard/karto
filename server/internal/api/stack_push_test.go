package api

import (
	"os"
	"testing"
)

// The docker stack test (deploy/test/stack-test.sh) runs this against its
// cardd through Caddy, signed with the test vectors' device key, while a
// subscriber of its own listens on CARDD_STACK_NTFY_TOPIC at the stack's
// ntfy: the device registers an endpoint on the server's own ntfy,
// sends itself a test alert, which cardd posts inside the stack with
// its token, and turns alerts off again. The subscriber, in the shell, is
// what shows the message arrived.
func TestAStackPushNtfy(t *testing.T) {
	base := os.Getenv("CARDD_STACK_URL")
	topic := os.Getenv("CARDD_STACK_NTFY_TOPIC")
	if base == "" || topic == "" {
		t.Skip("CARDD_STACK_URL or CARDD_STACK_NTFY_TOPIC not set")
	}
	call := stackCaller(t, base)
	status, out := call("GET", "/api/v1/push", nil)
	ntfy, _ := out["ntfy"].(string)
	if status != 200 || ntfy == "" {
		t.Fatalf("the server names no ntfy of its own: %d %v", status, out)
	}
	if status, out := call("PUT", "/api/v1/push", pushBody(ntfy+"/"+topic+"?up=1", "unifiedpush")); status != 200 {
		t.Fatalf("register an endpoint on the server's ntfy: %d %v", status, out)
	}
	if status, out := call("POST", "/api/v1/push/test", nil); status != 200 || out["delivered"] != true {
		t.Fatalf("the test alert: %d %v", status, out)
	}
	_, out = call("GET", "/api/v1/push", nil)
	ep, _ := out["endpoint"].(map[string]any)
	if ep == nil || ep["deliveredAt"] == nil || ep["failures"] != float64(0) {
		t.Fatalf("after the test alert: %v", out)
	}
	if status, _ := call("DELETE", "/api/v1/push", nil); status != 204 {
		t.Fatalf("alerts off: %d", status)
	}
}
