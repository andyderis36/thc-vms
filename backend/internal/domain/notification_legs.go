package domain

// This file owns the LEG MAP of the notification matrix: for every
// notification type it says which channel x audience cells actually have a
// send path behind them.
//
// The map is DERIVED from the templates the send paths emit - the Audience of
// the very same NotificationTemplate values - so it can never drift from the
// delivery behaviour. No audience is ever written down by hand and there is no
// second, hand-written list of events: the table below names the templates of
// each type, and the helper reads their Audience.
//
// The ONE send leg no template can describe is the ROSTER FAN-OUT: the
// lifecycle mail also reaches every visit roster member holding an email
// address, gated by the email.vendor cell (repository/email_enqueue.go:282).
// The roster members are visit recipients, not a template audience, so the
// leg table annotates that leg explicitly instead of inventing an audience
// for it.
//
// Why the matrix publishes it: a cell without a send leg is a dead switch.
// Switching it ON would store a promise the backend never keeps, so the
// matrix endpoint refuses to enable it and the admin UI renders it disabled.

// NotificationApplicability is the server-driven per-toggle leg map: which
// channel x audience cells actually have a send leg behind them.
type NotificationApplicability struct {
	InApp NotificationChannelToggle `json:"in_app"`
	Email NotificationChannelToggle `json:"email"`
}

// Allows reports whether every ENABLED cell of the given toggle has a send
// leg behind it. A disabled cell is always allowed: switching OFF a leg that
// does not exist is harmless, switching it ON is not.
func (a NotificationApplicability) Allows(inApp NotificationChannelToggle, email NotificationChannelToggle) bool {
	return (!inApp.Staff || a.InApp.Staff) &&
		(!inApp.Vendor || a.InApp.Vendor) &&
		(!email.Staff || a.Email.Staff) &&
		(!email.Vendor || a.Email.Vendor)
}

// notificationLegTemplate builds one template of a type's leg set. The
// applicability helper only reads the Audience off the built template, so a
// leg map can never restate an audience by hand.
type notificationLegTemplate func() *NotificationTemplate

// notificationLeg is the leg set of one notification type: the templates its
// send paths emit, plus the send legs that carry no template of their own.
type notificationLeg struct {
	// templates are the templates the send paths emit for the type. Their
	// audiences are READ off the built templates, never restated.
	templates []notificationLegTemplate
	// rosterEmailFanOut marks the EMAIL channel as carrying the roster
	// fan-out leg: the lifecycle fan-out mails every visit roster member
	// holding an email address whenever the email.vendor cell is ON
	// (repository/email_enqueue.go:282; the reminder worker does the same
	// for visit_reminder, worker/rules.go:416). The roster members are visit
	// recipients, not a template audience, so no template can reveal this
	// leg - it is annotated here, in the ONE leg table.
	//
	// The leg is email-only: a roster member never gains an in_app row, so
	// the annotation opens the email.vendor cell alone.
	rosterEmailFanOut bool
}

// notificationLegs is the ONE leg table: for each notification type it names
// the templates the send paths emit for it and annotates the send legs that
// carry no template. Every entry mirrors one send path, so adding a template
// to a delivery path means listing it here - and the audiences themselves are
// read off the templates, never restated.
//
//   - visit_requested     CreatedNotification (repository.Create -> emit)
//   - visit_rescheduled   TransitionNotification(rescheduled) staff +
//     RescheduledVendorNotification vendor (repository.Reschedule)
//   - visit_check_in      TransitionNotification(visiting) staff (repository.UpdateStatus)
//   - visit_check_out     TransitionNotification(completed) staff (repository.UpdateStatus)
//   - visit_cancelled     HumanCancelledNotification, either side (repository.UpdateStatus)
//   - visit_approved      TransitionNotification(approved) vendor (repository.UpdateStatus)
//   - visit_rejected      TransitionNotification(rejected) vendor (repository.UpdateStatus)
//   - visit_reminder      ReminderNotification vendor + ReminderStaffNotification staff (worker R4)
//   - visit_auto_cancelled TransitionNotification(cancelled, system) vendor +
//     AutoCancelledStaffNotification staff (repository.UpdateStatus + worker R1)
var notificationLegs = map[NotificationType]notificationLeg{
	NotificationVisitRequested: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return CreatedNotification("") },
		},
		// enqueueCreateEmail mails the approvers only (branch admins in To,
		// national overseers in Bcc) and has NO roster loop, so the
		// email.vendor cell of visit_requested has no leg behind it.
	},
	NotificationVisitRescheduled: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusRescheduled, false, "", "") },
			func() *NotificationTemplate { return RescheduledVendorNotification("", "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitCheckIn: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusVisiting, false, "", "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitCheckOut: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusCompleted, false, "", "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitCancelled: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return HumanCancelledNotification("", true, "") },
			func() *NotificationTemplate { return HumanCancelledNotification("", false, "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitApproved: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusApproved, false, "", "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitRejected: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusRejected, false, "", "") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitReminder: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return ReminderNotification("") },
			func() *NotificationTemplate { return ReminderStaffNotification("") },
		},
		rosterEmailFanOut: true,
	},
	NotificationVisitAutoCancelled: {
		templates: []notificationLegTemplate{
			func() *NotificationTemplate { return TransitionNotification(VisitStatusCancelled, true, "", "") },
			func() *NotificationTemplate { return AutoCancelledStaffNotification("") },
		},
		rosterEmailFanOut: true,
	},
}

// MaskByApplicability ANDs one channel toggle with its leg map: a cell with
// no send leg behind it is published/stored OFF, because a stored ON there is
// a dead switch the backend never keeps. It is the ONE masking rule, shared
// by the matrix endpoint (published state) and the settings usecase (stored
// state), so the two can never drift.
func MaskByApplicability(toggle NotificationChannelToggle, applicable NotificationChannelToggle) NotificationChannelToggle {
	return NotificationChannelToggle{
		Staff:  toggle.Staff && applicable.Staff,
		Vendor: toggle.Vendor && applicable.Vendor,
	}
}

// NotificationApplicabilityFor returns the leg map of t: which channel x
// audience cells the send paths actually deliver.
//
// Both channels share one derivation because every template reaches its own
// audience on both: the in_app rows are written by emit/InsertForVisit and
// the mail by enqueueEmail/enqueueCreateEmail/the reminder worker, always for
// the same audience. The email channel carries ONE leg beyond the template
// audiences - the roster fan-out, which mails the visit roster members
// without any template of its own - so the leg table annotates it.
//
// A mandatory type reports all-true: its row is locked Active by the matrix,
// so the lock is the only gate there and a missing leg must not contradict
// the lock the admin sees.
func NotificationApplicabilityFor(t NotificationType) NotificationApplicability {
	if IsMandatoryNotification(t) {
		on := NotificationChannelToggle{Staff: true, Vendor: true}
		return NotificationApplicability{InApp: on, Email: on}
	}
	leg := notificationLegs[t]
	var app NotificationApplicability
	for _, build := range leg.templates {
		tpl := build()
		if tpl == nil {
			continue
		}
		switch tpl.Audience {
		case NotificationAudienceStaff:
			app.InApp.Staff = true
			app.Email.Staff = true
		case NotificationAudienceVendor:
			app.InApp.Vendor = true
			app.Email.Vendor = true
		}
	}
	if leg.rosterEmailFanOut {
		app.Email.Vendor = true
	}
	return app
}
