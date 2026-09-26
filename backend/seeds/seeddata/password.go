package seeddata

import (
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

const (
	// DemoPassword is the demo credential published in docs/5. LOCAL_DEV.md 6.1.
	// It exists here because the seeder has to hash it; it is never written to
	// the database and never logged.
	DemoPassword = "Password123!"

	// SeedBcryptCost is the cost factor docs/5. LOCAL_DEV.md 6 mandates.
	SeedBcryptCost = 10
)

// HashSeedPasswords returns an independent bcrypt hash per account. One call
// per account on purpose: hashing the same password once and reusing the blob
// would give every demo account the same salt, so a leaked hash identifies all
// seven accounts at once.
func HashSeedPasswords(users []SeedUser) (map[string]string, error) {
	hashes := make(map[string]string, len(users))
	for _, u := range users {
		hash, err := bcrypt.GenerateFromPassword([]byte(DemoPassword), SeedBcryptCost)
		if err != nil {
			return nil, fmt.Errorf("hash password for %s: %w", u.Email, err)
		}
		hashes[u.Email] = string(hash)
	}
	return hashes, nil
}
