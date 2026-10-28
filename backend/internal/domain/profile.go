package domain

// profilePhotoDirectory mirrors the storage adapter's profile_photo category
// directory (infrastructure/storage/object_key.go) so the object-key layout is
// stated once for the layers that must agree on it.
const profilePhotoDirectory = "profile_photos/"

// ProfilePhotoOwnerPrefix returns the object-key prefix owned by one account's
// self-service profile photo: the upload handler's server-derived owner segment
// ("pending-<userID>") inside the profile directory, with a trailing slash so a
// prefix check can never accept a sibling id such as "user-1x".
//
// The delivery upload path and the auth profile-write gate share this helper:
// the ownership proof must compare against exactly the namespace the upload
// handler writes.
func ProfilePhotoOwnerPrefix(userID UUID) string {
	return profilePhotoDirectory + "pending-" + string(userID) + "/"
}
