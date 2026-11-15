package renew

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/boltcard/karto/server/internal/alerts"
	"github.com/boltcard/karto/server/internal/store"
)

// Alerter sends hosting's low-funding alert to the owner's phones:
// alerts.Sender. False when its queue was full.
type Alerter interface {
	Send(p alerts.Payload, urg alerts.Urgency) bool
}

const (
	// LowFundingDays: under this many days of runway (funding plus the days
	// paid beyond RenewTo), hosting's alert goes out once a day,
	// as the app shows the funding line red.
	LowFundingDays = 7
	// AlertHour is the phone's local hour from which the day's alert goes:
	// the first run of the job at or after it.
	AlertHour = 9

	keyOffset   = "hosting.utc_offset_min" // the phone's offset from UTC, minutes, from the app's sync
	keyAlertDay = "hosting.low_alert_day"  // the phone's local day ("YYYY-MM-DD") the last alert was queued
)

// lowFundingAlert sends hosting's alert once a local day, from AlertHour,
// while the runway is under LowFundingDays: what hosting's available balance
// pays for, plus the days the VM is paid beyond the RenewTo the job keeps it
// at (a VM paid 30 days ahead isn't short of hosting). It runs after every run's
// renewal, whatever the renewal did: a paused server still says hosting is
// low. The payload counts hosting's own days. The day is kept only once the
// alert is queued.
func (r *Renewer) lowFundingAlert(ctx context.Context) {
	if r.Alerts == nil {
		return
	}
	e, err := r.load(ctx)
	if err != nil || !e.synced {
		return
	}
	b, err := r.Store.Balance(ctx, store.Hosting)
	if err != nil {
		r.Log.Printf("renew: %v", err)
		return
	}
	now := r.Now()
	days := float64(b.AvailableMsat()) / float64(e.msatPerDay)
	if runway(days, e.expires.Sub(now)) >= LowFundingDays {
		return
	}
	local := now.UTC().Add(time.Duration(e.offsetMin) * time.Minute)
	day := local.Format(time.DateOnly)
	if local.Hour() < AlertHour || day == e.alertDay {
		return
	}
	if !r.Alerts.Send(alerts.HostingLow(b.AvailableMsat(), int(math.Floor(max(days, 0))), now), alerts.UrgencyNormal) {
		r.Log.Printf("alerts: queue full: hosting's low-funding alert not sent")
		return
	}
	if err := r.Store.SetMetas(ctx, map[string]string{keyAlertDay: day}); err != nil {
		r.Log.Printf("renew: keeping the alert's day: %v", err)
	}
}

// offsetOK is a UTC offset a phone can have, in minutes (UTC−12 to UTC+14).
func offsetOK(min int) bool { return min >= -720 && min <= 840 }

func formatOffset(min int) string { return strconv.Itoa(min) }

// runway is how many days hosting keeps the VM going without a top-up:
// hosting's days of funding plus the days paid beyond RenewTo (none when the
// VM is at or under it, as the daily renewal keeps it).
func runway(fundingDays float64, paidLeft time.Duration) float64 {
	return fundingDays + max(0, (paidLeft-RenewTo).Hours()/24)
}
