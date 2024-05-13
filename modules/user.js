const User = require("../db/models/User");
const Friendship = require("../db/models/Friendship");

const bcrypt = require("bcrypt");
const queryLimit = 3;

/* ---------------------------------------------------------------- */
/*                          Handle profile                          */
/* ---------------------------------------------------------------- */

async function getProfile(userId = "", username = "") {
	try {
		let query = {};
		let isOwn = false;

		if (username) {
			query = { username: { $regex: new RegExp(username, "i") } };
		} else {
			isOwn = true;
			query = { _id: userId };
		}

		let selectParams = "-_id username avatar bio status createdAt";

		if (isOwn) {
			selectParams = "-_id username email avatar bio status createdAt";
		}

		const profile = await User.findOne(query).select(selectParams);

		if (!profile) {
			return { success: false, error: "No profile found" };
		}

		return { success: true, profile };
	} catch (e) {
		return { success: false, error: e.message };
	}
}

async function updateProfile(userId = "", type = "", value = "") {
	try {
		if (["bio", "username", "email"].includes(type)) {
			await User.findByIdAndUpdate(userId, { [type]: value });
			return { success: true, message: "Profile successfully updated" };
		} else if (type === "password") {
			const user = await User.findById(userId).select("password");
			const isPasswordMatch = bcrypt.compareSync(value, user.password);

			if (!isPasswordMatch) {
				await User.findByIdAndUpdate(userId, { [type]: bcrypt.hashSync(value, 10) });
				return { success: true, message: "Password successfully updated" };
			} else {
				return { success: false, error: "The old and new passwords cannot be the same" };
			}
		} else {
			return { success: false, error: "Invalid query" };
		}
	} catch (e) {
		return { success: false, error: e.message };
	}
}

/* ---------------------------------------------------------------- */
/*                           Handle avatar                          */
/* ---------------------------------------------------------------- */

async function updateAvatar(userId = "", uri = "") {
	try {
		const updatedUser = await User.findByIdAndUpdate(userId, { avatar: uri });
		if (!updatedUser) {
			return { success: false, error: "User not modified" };
		}

		return { success: true, message: "Avatar successfully modified" };
	} catch (e) {
		return { success: false, error: e.message };
	}
}

/* ---------------------------------------------------------------- */
/*                        Handle friend list                        */
/* ---------------------------------------------------------------- */

/* ---------------------- Update friend list ---------------------- */

async function updateFriendList(userId = "", username = "", ref = "", requestId = "") {
	try {
		if (["accept", "reject"].includes(ref)) {
			if (requestId) {
				const friendship = await Friendship.findById(requestId);

				if (friendship) {
					const { status, sender, receiver } = friendship;
					const isReceiver = userId === friendship.receiver.toString();

					if (isReceiver) {
						if (status === "pending") {
							if (ref === "accept") {
								Promise.allSettled([
									Friendship.findByIdAndUpdate(friendship._id, { status: "confirmed" }),
									User.findByIdAndUpdate(sender, { $addToSet: { friends: receiver } }),
									User.findByIdAndUpdate(receiver, { $addToSet: { friends: sender } }),
								]);

								return { success: true, error: "Friendship successfully validated" };
							} else {
								Promise.allSettled([
									Friendship.findByIdAndUpdate(friendship._id, { status: "cancelled" }),
									User.findByIdAndUpdate(sender, { $pull: { friends: receiver } }),
									User.findByIdAndUpdate(receiver, { $pull: { friends: sender } }),
								]);

								return { success: true, error: "Friendship successfully rejected" };
							}
						} else {
							return { success: false, error: "Friendship request already handled" };
						}
					} else {
						return { success: false, error: "Not allowed" };
					}
				} else {
					return { success: false, error: "Friendship request not found" };
				}
			} else {
				return { success: false, error: "Friendship request ID missing" };
			}
		} else {
			if (username) {
				const target = await User.findOne({ username: { $regex: new RegExp(username, "i") } }).select("_id");

				if (target) {
					const friendship = await Friendship.findOne({
						$or: [
							{ sender: userId, receiver: target._id },
							{ sender: target._id, receiver: userId },
						],
					});

					if (friendship) {
						const { status, sender, receiver } = friendship;

						if (status !== "locked") {
							if (ref === "create") {
								if (status === "cancelled") {
									await Friendship.findByIdAndUpdate(friendship._id, { sender: userId, receiver: target._id, status: "pending" });

									return { success: true, message: "Friendship request successfully sent" };
								} else if (status === "pending") {
									return { success: false, error: "Friend request already awaiting confirmation" };
								} else if (status === "confirmed") {
									return { success: false, error: "Friend already in your list" };
								}
							} else {
								if (status !== "cancelled") {
									if (status === "confirmed") {
										Promise.allSettled([
											User.findByIdAndUpdate(sender, { $pull: { friends: receiver } }),
											User.findByIdAndUpdate(receiver, { $pull: { friends: sender } }),
										]);
									}

									await Friendship.findByIdAndUpdate(friendship._id, { status: "cancelled" });

									return { success: true, message: "Friendship successfully cancelled" };
								} else {
									return { success: false, error: "Person already cancelled" };
								}
							}
						} else {
							return { success: false, error: "Operation forbidden. Please contact the support team" };
						}
					} else {
						if (ref === "create") {
							const newFriendship = await new Friendship({ sender: userId, receiver: target._id, status: "pending" });

							await newFriendship.save();

							return { success: true, message: "Friendship request successfully sent" };
						} else {
							return { success: false, error: "No friendship found" };
						}
					}
				} else {
					return { success: false, error: "Target user not found" };
				}
			} else {
				return { success: false, error: "Username missing" };
			}
		}
	} catch (e) {
		return { success: false, error: e.message };
	}
}

/* ---------------- Get friend list with pagination --------------- */

async function getFriendList(userId = "", ref = "", page = 1) {
	try {
		let query = { $or: [{ status: { $ne: "locked" } }, { status: { $ne: "cancelled" } }] };

		if (ref === "all") {
			query["$or"] = [{ sender: userId }, { receiver: userId }];
		} else if (ref === "received") {
			query.status = "pending";
			query.receiver = userId;
		} else if (ref === "sent") {
			query.status = "pending";
			query.sender = userId;
		} else {
			delete query["$or"];
			query.status = "confirmed";
		}

		const friendships = await Friendship.find(query)
			.limit(queryLimit)
			.skip(queryLimit * page - queryLimit)
			.populate("sender receiver");

		const friendList = friendships.map((f) => {
			let friend = {};

			if (f.sender._id.toString() !== userId) {
				friend = f.sender;
			} else {
				friend = f.receiver;
			}

			let obj = {
				requestId: f._id,
				username: friend.username,
				avatar: friend.avatar,
				isOnline: friend.status === "online",
				friendshipStatus: f.status,
				friendshipDate: f.updatedAt,
			};

			if (ref === "received") {
				obj.requestId = f._id;
			}

			return obj;
		});

		return { success: true, friendList };
	} catch (e) {
		return { success: false, error: e.message };
	}
}

module.exports = { getProfile, updateProfile, updateAvatar, updateFriendList, getFriendList };
