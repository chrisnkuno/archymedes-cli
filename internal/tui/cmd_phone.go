package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/phone"
)

// /phone pairs a phone with this computer (docs/engine/PHONE_PROTOCOL.md): a QR code of the phone
// page with the pairing secret in its fragment. /phone new pairs afresh, which shuts every phone
// paired before out; /phone off forgets the pairing; /phone status says whether a phone is there.
func (m *Model) cmdPhone(arg string) tea.Cmd {
	if m.opts.ConfigDir == "" {
		return m.toast(toastWarn, "No settings folder to keep a pairing in")
	}
	switch strings.TrimSpace(arg) {
	case "", "show":
		s, ok, err := phone.LoadPairing(m.opts.ConfigDir)
		if err != nil || !ok {
			if s, err = phone.NewSecret(); err == nil {
				err = phone.SavePairing(m.opts.ConfigDir, s)
			}
		}
		if err != nil {
			return m.toast(toastWarn, "Could not pair: "+err.Error())
		}
		if m.link == nil || m.link.secret != s {
			m.linkStart(s)
		}
		return m.showPairing(s)
	case "new":
		s, err := phone.NewSecret()
		if err == nil {
			err = phone.SavePairing(m.opts.ConfigDir, s)
		}
		if err != nil {
			return m.toast(toastWarn, "Could not pair: "+err.Error())
		}
		m.linkStart(s)
		return tea.Batch(m.showPairing(s), m.toast(toastInfo, "Paired afresh: phones paired before are shut out"))
	case "off":
		m.linkStop()
		if err := phone.DeletePairing(m.opts.ConfigDir); err != nil {
			return m.toast(toastWarn, "Could not forget the pairing: "+err.Error())
		}
		return m.toast(toastInfo, "Phone unpaired: the link is closed and the pairing forgotten")
	case "status":
		return m.toast(toastInfo, m.linkStatus())
	}
	return m.toast(toastWarn, "/phone, /phone new, /phone off or /phone status")
}

// linkStatus is the link in a line.
func (m *Model) linkStatus() string {
	switch {
	case m.link == nil:
		return "No phone paired; /phone pairs one"
	case !m.link.online:
		return "Paired, but the relay cannot be reached just now; Friday keeps trying"
	case m.link.phones == 0:
		return "Paired; no phone has the page open"
	case m.link.phones == 1:
		return "Paired; one phone is watching"
	}
	return fmt.Sprintf("Paired; %d phones are watching", m.link.phones)
}

// showPairing opens the QR code and what to do with it.
func (m *Model) showPairing(s phone.Secret) tea.Cmd {
	link := s.Link(linkPage)
	code, err := phone.EncodeQR(link)
	if err != nil {
		return m.toast(toastWarn, "Could not draw the code: "+err.Error())
	}
	lines := strings.Split(strings.TrimRight(phone.RenderQR(code), "\n"), "\n")
	lines = append(lines, "",
		"Scan this with your phone's camera to work from it while you are away.",
		"The phone sees this session live, sends messages, answers approvals and",
		"questions, and can stop, undo, switch mode or restart a stuck command.",
		"",
		"The code is the key: the relay between you sees only sealed messages.",
		"Keep it private. /phone new pairs afresh and shuts out every phone before.",
		"",
		"Or open on the phone: "+link)
	m.openWindow(newPager(m, "Phone", lines))
	return nil
}
