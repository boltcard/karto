package api

import (
	"time"
	"unicode/utf8"
)

// refundNote is a refund's note to the customer, as LUD-12's comment:
// "Refund from <the wallet's name> for the sale of 17:22, 20 Oct", the sale's paid time in the phone's offset
// (minutes east of UTC; nil when the phone gave none: no time then, rather than one in a zone the owner never chose).
// Fitted to a pay request's limit in characters by dropping whole parts, the date first, then the sale, then the
// name; "" when even "Refund" doesn't fit. The name is the wallet's, checked when it was set (store.CleanName).
func refundNote(name string, paidAt time.Time, offsetMin *int) func(limit int) string {
	from := ""
	if name != "" {
		from = " from " + name
	}
	sale, day := "", ""
	if offsetMin != nil && !paidAt.IsZero() {
		at := paidAt.In(time.FixedZone("", *offsetMin*60))
		sale, day = " for the sale of "+at.Format("15:04"), ", "+at.Format("2 Jan")
	}
	tries := []string{"Refund" + from + sale + day, "Refund" + from + sale, "Refund" + from, "Refund"}
	return func(limit int) string {
		for _, s := range tries {
			if utf8.RuneCountInString(s) <= limit {
				return s
			}
		}
		return ""
	}
}
