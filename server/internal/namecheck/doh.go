package namecheck

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"

	"golang.org/x/net/dns/dnsmessage"
)

// DoH looks a name's A records up over DNS-over-HTTPS (RFC 8484), asking every service at once and taking the first
// that answers: what phones out there see, not what the VM's resolver or Docker's has cached. services are
// bip353.Services; client is lnaddr's, which only connects to public addresses.
func DoH(client *http.Client, services []string) LookupA {
	return func(ctx context.Context, host string) ([]string, error) {
		q, err := question(host)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		type reply struct {
			ips []string
			err error
		}
		replies := make(chan reply, len(services))
		for _, svc := range services {
			go func() {
				ips, err := ask(ctx, client, svc, q)
				replies <- reply{ips, err}
			}()
		}
		var errs []error
		for range services {
			r := <-replies
			if r.err == nil || errors.Is(r.err, ErrNoRecord) {
				return r.ips, r.err
			}
			errs = append(errs, r.err)
		}
		return nil, fmt.Errorf("namecheck: no DNS service answered: %w", errors.Join(errs...))
	}
}

// question is an A query for host, id 0 as RFC 8484 asks.
func question(host string) ([]byte, error) {
	name := host
	if name == "" || name[len(name)-1] != '.' {
		name += "."
	}
	n, err := dnsmessage.NewName(name)
	if err != nil {
		return nil, fmt.Errorf("namecheck: %q can't be asked: %w", host, err)
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{RecursionDesired: true})
	if err := b.StartQuestions(); err != nil {
		return nil, err
	}
	if err := b.Question(dnsmessage.Question{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}); err != nil {
		return nil, err
	}
	return b.Finish()
}

// ask is one service's answer: the A records, ErrNoRecord for a name that doesn't exist or has none, or why it
// couldn't say.
func ask(ctx context.Context, client *http.Client, service string, q []byte) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", service, bytes.NewReader(q))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered HTTP %d", service, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	var m dnsmessage.Message
	if err := m.Unpack(body); err != nil {
		return nil, fmt.Errorf("%s: %w", service, err)
	}
	switch m.RCode {
	case dnsmessage.RCodeSuccess:
	case dnsmessage.RCodeNameError:
		return nil, ErrNoRecord
	default:
		return nil, fmt.Errorf("%s answered %v", service, m.RCode)
	}
	var ips []string
	for _, a := range m.Answers {
		if r, ok := a.Body.(*dnsmessage.AResource); ok {
			ips = append(ips, net.IP(r.A[:]).String())
		}
	}
	if len(ips) == 0 {
		return nil, ErrNoRecord
	}
	return ips, nil
}
